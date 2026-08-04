import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { userIdFromCookieHeader } from "../lib/auth.js";
import { checkRateLimit } from "../lib/rateLimiter.js";
import { streamAnswer } from "../rag/generateAnswer.js";

interface AuthedSocket extends WebSocket {
  userId: string;
}

const askSchema = z.object({
  type: z.literal("ask"),
  conversationId: z.string().uuid(),
  question: z.string().min(1).max(2000),
});

function send(ws: WebSocket, payload: unknown) {
  // Guard every send, not just the first: the client can disconnect mid-
  // stream (closed tab, network drop) between any two `yield`s in
  // streamAnswer's loop, and ws throws if you call .send() on a socket
  // that's already past OPEN. This is the one check that has to wrap
  // every single send, so it's centralized here instead of repeated at
  // each call site below.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Attaches a WebSocket server to the existing HTTP server, sharing one port
 * (no separate WS port to configure/expose on Render). Auth happens during
 * the upgrade handshake — before `connection` fires — by parsing the same
 * httpOnly cookie the REST API uses (see lib/auth.ts's
 * userIdFromCookieHeader). Rejecting unauthenticated upgrades here, rather
 * than accepting the connection and checking on the first message, avoids
 * ever handing an anonymous client a live socket at all.
 */
export function attachSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }

    const userId = userIdFromCookieHeader(req.headers.cookie);
    if (!userId) {
      // Manually written 401 response: at this point we're below Express
      // entirely (raw 'upgrade' event on the underlying http.Server), so
      // there's no res.status().json() available — this is the http/1.1
      // wire format for rejecting the Upgrade request outright.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as AuthedSocket).userId = userId;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (rawWs) => {
    const ws = rawWs as AuthedSocket;

    ws.on("message", (raw) => {
      void handleMessage(ws, raw.toString());
    });
  });

  return wss;
}

async function handleMessage(ws: AuthedSocket, raw: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return send(ws, { type: "error", error: "Malformed message (not valid JSON)" });
  }

  const parsed = askSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return send(ws, { type: "error", error: "Invalid message shape", details: parsed.error.flatten() });
  }
  const { conversationId, question } = parsed.data;

  const rateLimit = await checkRateLimit(ws.userId);
  if (!rateLimit.allowed) {
    return send(ws, {
      type: "error",
      error: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s.`,
    });
  }

  // Same ownership check the REST POST /:id/messages route makes — a
  // WebSocket connection is authenticated once at the handshake, but every
  // individual 'ask' message still names its own conversationId, and
  // nothing stops a client from sending one that belongs to someone else
  // (or doesn't exist). This has to be re-checked per message, not just
  // once at connect time.
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ws.userId)))
    .limit(1);

  if (!conversation) {
    return send(ws, { type: "error", error: "Conversation not found" });
  }

  try {
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "user",
      content: question,
    });

    for await (const event of streamAnswer(conversation.documentId, question)) {
      if (event.type === "token") {
        send(ws, { type: "token", conversationId, text: event.text });
        continue;
      }

      const [assistantMessage] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          role: "assistant",
          content: event.answer.answerText,
          citedChunkIds: event.answer.citedChunkIds,
        })
        .returning();

      send(ws, {
        type: "done",
        conversationId,
        message: assistantMessage,
        isAnswerable: event.answer.isAnswerable,
        retrievedChunkCount: event.answer.retrievedChunkCount,
        usedChunkCount: event.answer.usedChunkCount,
        citations: event.answer.citations,
      });
    }
  } catch (err) {
    console.error(`Streaming answer failed for conversation ${conversationId}:`, err);
    send(ws, { type: "error", conversationId, error: "Failed to generate an answer. Please try again." });
  }
}
