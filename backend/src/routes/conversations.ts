import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversations, documents, messages, chunks } from "../db/schema.js";
import { generateAnswer } from "../rag/generateAnswer.js";
import { checkRateLimit } from "../lib/rateLimiter.js";

export const conversationsRouter = Router();

const EXCERPT_MAX_CHARS = 220;

// Reconstructs a page/excerpt list for a message's already-persisted
// citedChunkIds. Used when reloading history (GET), where we only have the
// flat uuid[] the schema stores — not the marker->chunk mapping that exists
// transiently right after generation (see rag/promptTemplate.ts docstring).
// Order here is whatever citedChunkIds happens to be in (ascending marker,
// per parseCitations), which is a reasonable "sources" ordering even without
// being able to point back at individual [n] positions in old text.
async function hydrateCitations(citedChunkIds: string[]) {
  if (citedChunkIds.length === 0) return [];

  const rows = await db
    .select({ id: chunks.id, pageNumber: chunks.pageNumber, content: chunks.content })
    .from(chunks)
    .where(inArray(chunks.id, citedChunkIds));

  const byId = new Map(rows.map((r) => [r.id, r]));
  return citedChunkIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({
      chunkId: r.id,
      pageNumber: r.pageNumber,
      excerpt: r.content.length > EXCERPT_MAX_CHARS ? r.content.slice(0, EXCERPT_MAX_CHARS).trim() + "…" : r.content,
    }));
}

const createConversationSchema = z.object({
  documentId: z.string().uuid(),
});

const askQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
});

// POST /api/conversations
// Creates a conversation scoped to one document. We require the document to
// exist, belong to the caller, AND be status 'ready' — asking a question
// against a document that's still processing (or failed) would just hit an
// empty chunks table and always return the "no relevant answer" fallback,
// which is a confusing dead end rather than a clear error telling the user
// what's actually wrong.
conversationsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, parsed.data.documentId), eq(documents.userId, req.userId)))
      .limit(1);

    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    if (doc.status !== "ready") {
      return res.status(409).json({
        error: `Document is not ready for questions (status: ${doc.status})`,
      });
    }

    const [created] = await db
      .insert(conversations)
      .values({ userId: req.userId, documentId: doc.id })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations
conversationsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, req.userId))
      .orderBy(asc(conversations.createdAt));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/messages
conversationsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, req.params.id), eq(conversations.userId, req.userId)))
      .limit(1);

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.createdAt));

    // Historical citations have no marker mapping (see hydrateCitations
    // docstring) — the frontend renders these as a "Sources" footer rather
    // than inline clickable [n] chips, which only fresh answers get.
    const withCitations = await Promise.all(
      rows.map(async (m) => ({ ...m, citations: await hydrateCitations(m.citedChunkIds) }))
    );

    res.json(withCitations);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/messages
// Asks a question against the conversation's document. No streaming yet —
// Phase 5 swaps this response shape for SSE. For now it blocks until the
// full answer is generated and returns it as one JSON payload, which also
// makes this route trivial to test with a plain curl/supertest request.
conversationsRouter.post("/:id/messages", async (req, res, next) => {
  try {
    const parsed = askQuestionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    // Same limiter/window the WS 'ask' handler uses (src/lib/rateLimiter.ts)
    // — both paths end up calling the LLM, so both have to be covered by
    // the same per-user budget, or a client could bypass the limit by
    // switching protocols mid-abuse.
    const rateLimit = await checkRateLimit(req.userId);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", Math.ceil(rateLimit.retryAfterMs / 1000).toString());
      return res.status(429).json({
        error: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s.`,
      });
    }

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, req.params.id), eq(conversations.userId, req.userId)))
      .limit(1);

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Persist the user's message first, independent of whether generation
    // succeeds below — the conversation transcript should show what was
    // asked even if answering it then fails, rather than silently dropping
    // the question from history on an LLM-call error.
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "user",
      content: parsed.data.question,
    });

    const result = await generateAnswer(conversation.documentId, parsed.data.question);

    const [assistantMessage] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        content: result.answerText,
        citedChunkIds: result.citedChunkIds,
      })
      .returning();

    res.status(201).json({
      message: assistantMessage,
      isAnswerable: result.isAnswerable,
      retrievedChunkCount: result.retrievedChunkCount,
      usedChunkCount: result.usedChunkCount,
      // Marker-mapped (this.marker matches the [n] printed in message.content)
      // — only available right here, right after generation. See
      // rag/promptTemplate.ts for why this isn't persisted as-is.
      citations: result.citations,
    });
  } catch (err) {
    next(err);
  }
});
