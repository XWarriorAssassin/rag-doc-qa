import { openrouter, CHAT_MODEL } from "../lib/openrouter.js";
import { embedTexts } from "../pipeline/embedChunks.js";
import { retrieveChunks, MAX_RELEVANT_DISTANCE } from "./retrieveChunks.js";
import {
  buildPrompt,
  NO_ANSWER_SENTINEL,
  parseCitations,
  type ParsedAnswer,
  type PromptChunk,
} from "./promptTemplate.js";

export interface RagAnswer extends ParsedAnswer {
  retrievedChunkCount: number;
  usedChunkCount: number; // how many chunks survived the relevance threshold
}

export const FALLBACK_MESSAGE =
  "I couldn't find relevant information about that in this document. Try rephrasing your question, or check that it's actually covered in the uploaded PDF.";

function noAnswer(retrievedChunkCount: number, usedChunkCount: number): RagAnswer {
  return {
    isAnswerable: false,
    answerText: FALLBACK_MESSAGE,
    citedChunkIds: [],
    citations: [],
    retrievedChunkCount,
    usedChunkCount,
  };
}

// Some free-tier OpenRouter models (observed on the Gemma checkpoint this
// project uses) occasionally prepend a moderation-classifier line before —
// or instead of — the actual answer, e.g. "User Safety: safe" or
// "**Assistant Safety:** safe". That's an artifact of how the provider
// wraps the model, not part of the answer, and our own system prompt never
// asks for it. Strip any leading run of such lines (plus the blank line
// that typically follows) before treating the rest as the real completion.
const SAFETY_PREAMBLE_LINE = /^\s*\**\s*(?:user|assistant|model|response|bot)\s+safety\s*:\**\s*\S+\s*\**\s*$/i;

function stripSafetyPreamble(text: string): string {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && SAFETY_PREAMBLE_LINE.test(lines[i] ?? "")) i++;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return lines.slice(i).join("\n").trim();
}
// Some models append a second, contradictory NOT_FOUND_IN_DOCUMENT after
// an otherwise complete, well-cited answer — effectively continuing past
// the instruction instead of choosing one branch of it. Strip a trailing
// sentinel line rather than only checking for an exact full-completion
// match, so a good answer doesn't get a bogus refusal tacked onto it.
function stripTrailingSentinel(text: string): string {
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  while (end > 0 && (lines[end - 1] ?? "").trim() === NO_ANSWER_SENTINEL) end--;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(0, end).join("\n").trim();
}

type PreparedPrompt =
  | { kind: "no_answer"; result: RagAnswer }
  | {
      kind: "ready";
      systemPrompt: string;
      userPrompt: string;
      promptChunks: PromptChunk[];
      retrievedChunkCount: number;
      usedChunkCount: number;
    };

/**
 * The embed -> retrieve -> relevance-filter -> build-prompt steps, shared by
 * both the non-streaming (`generateAnswer`) and streaming (`streamAnswer`)
 * entry points below. Everything through here is identical between the two
 * — retrieval doesn't stream, only the LLM's token output does — so this is
 * the one place that logic lives, rather than duplicated across both
 * consumers and risking them drifting apart.
 *
 * Two independent places can produce the "no answer" outcome, and both are
 * intentional:
 *  1. Retrieval-layer cutoff (MAX_RELEVANT_DISTANCE): if nothing in the
 *     document is even topically close to the question, we never call the
 *     LLM at all — cheaper, faster, and removes any chance of the model
 *     rationalizing an answer from weakly-related context.
 *  2. Model-layer refusal (NOT_FOUND_IN_DOCUMENT), handled by callers after
 *     the completion comes back: even when chunks pass the distance
 *     threshold (same general topic), they might not actually answer THIS
 *     specific question.
 * Both funnel into the same fallback message so the frontend only needs to
 * handle one "no answer" shape regardless of which layer caught it.
 */
async function preparePrompt(documentId: string, question: string): Promise<PreparedPrompt> {
  const [questionEmbedding] = await embedTexts([question]);
  if (!questionEmbedding) {
    throw new Error("Failed to generate embedding for question");
  }

  const retrieved = await retrieveChunks(documentId, question, questionEmbedding);
  // A chunk is "relevant" if either leg of the hybrid search vouches for it:
  // close in embedding space, OR a direct full-text hit (literal keyword /
  // proper-noun overlap). See retrieveChunks.ts for the full rationale.
  const relevant = retrieved.filter(
    (c) => c.distance <= MAX_RELEVANT_DISTANCE || c.matchedVia.includes("fulltext")
  );

  if (relevant.length === 0) {
    return { kind: "no_answer", result: noAnswer(retrieved.length, 0) };
  }

  const { systemPrompt, userPrompt, promptChunks } = buildPrompt(question, relevant);
  return {
    kind: "ready",
    systemPrompt,
    userPrompt,
    promptChunks,
    retrievedChunkCount: retrieved.length,
    usedChunkCount: relevant.length,
  };
}

/** Applies the same cleanup + citation parsing to a completed raw completion, used by both entry points once they have the full text. */
function finalize(
  rawText: string | null | undefined,
  promptChunks: PromptChunk[],
  retrievedChunkCount: number,
  usedChunkCount: number
): RagAnswer {
  if (!rawText) {
    // Empty/missing content from the provider (rare, but seen with some
    // free-tier models under load) — treat as "no answer" rather than
    // crashing the request.
    return noAnswer(retrievedChunkCount, usedChunkCount);
  }

  const cleanedText = stripTrailingSentinel(stripSafetyPreamble(rawText));
  if (!cleanedText) {
    // The entire completion WAS a safety-classifier line and nothing else
    // — same failure mode as an empty response, same fallback.
    return noAnswer(retrievedChunkCount, usedChunkCount);
  }

  const parsed = parseCitations(cleanedText, promptChunks);
  return {
    ...parsed,
    answerText: parsed.isAnswerable ? parsed.answerText : FALLBACK_MESSAGE,
    retrievedChunkCount,
    usedChunkCount,
  };
}

/**
 * Full non-streaming RAG pipeline for one question. Kept alongside
 * `streamAnswer` (not replaced by it) because it's genuinely useful on its
 * own: the Phase 6 eval script wants one blocking call per question rather
 * than consuming a token stream, and it's trivially curl/supertest-able —
 * both real advantages, not just legacy leftovers.
 */
export async function generateAnswer(documentId: string, question: string): Promise<RagAnswer> {
  const prepared = await preparePrompt(documentId, question);
  if (prepared.kind === "no_answer") return prepared.result;

  const completion = await openrouter.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: prepared.systemPrompt },
      { role: "user", content: prepared.userPrompt },
    ],
    // Low temperature: this is a grounded-answer task, not creative writing.
    // We want the model to stick close to the provided excerpts rather than
    // exploring varied phrasings, which correlates with straying from the
    // source text.
    temperature: 0.2,
  });

  const rawText = completion.choices[0]?.message?.content;
  return finalize(rawText, prepared.promptChunks, prepared.retrievedChunkCount, prepared.usedChunkCount);
}

export type StreamEvent = { type: "token"; text: string } | { type: "done"; answer: RagAnswer };

/**
 * Streaming counterpart to `generateAnswer`, consumed by the WebSocket
 * handler. Yields `{type: "token"}` events as the model's completion
 * arrives, then exactly one final `{type: "done"}` event carrying the same
 * `RagAnswer` shape `generateAnswer` returns — citation parsing needs the
 * FULL text (a `[1]` marker could be split across two chunks), so it can
 * only happen once streaming ends, not incrementally per token. The
 * frontend renders raw tokens live and swaps in the citation-annotated
 * final text once `done` arrives.
 *
 * This is an async generator rather than a callback-based API
 * (`onToken`/`onDone`) because the caller (socketServer.ts) already needs
 * to `for await` other things in the same handler (e.g. checking the socket
 * is still open between chunks) — a generator composes into that loop
 * directly, where callbacks would need their own manual cancellation
 * plumbing to achieve the same thing.
 */
export async function* streamAnswer(documentId: string, question: string): AsyncGenerator<StreamEvent> {
  const prepared = await preparePrompt(documentId, question);
  if (prepared.kind === "no_answer") {
    yield { type: "done", answer: prepared.result };
    return;
  }

  const stream = await openrouter.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: prepared.systemPrompt },
      { role: "user", content: prepared.userPrompt },
    ],
    temperature: 0.2,
    stream: true,
  });

  let rawText = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      rawText += delta;
      yield { type: "token", text: delta };
    }
  }

  const answer = finalize(rawText, prepared.promptChunks, prepared.retrievedChunkCount, prepared.usedChunkCount);
  yield { type: "done", answer };
}
