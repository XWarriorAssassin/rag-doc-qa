// Mirrors src/db/schema.ts + the response shapes the routes actually return.
// Kept hand-written rather than generated (no OpenAPI spec in this project)
// — for a two-person-scale portfolio project, keeping this file in sync by
// hand when a route changes is a fine tradeoff. At real scale this is
// exactly what tools like zod-to-openapi or tRPC exist to make automatic;
// noted in the README's "what I'd do differently at scale" section.

export interface UserRecord {
  id: string;
  email: string;
  createdAt: string;
}

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface DocumentRecord {
  id: string;
  userId: string;
  filename: string;
  storagePath: string;
  status: DocumentStatus;
  pageCount: number | null;
  errorMessage: string | null;
  uploadedAt: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  documentId: string;
  createdAt: string;
}

// A resolved citation: which chunk, which page, what it says.
// `marker` (the exact [n] the model printed) is only present on citations
// attached to a message immediately after it was generated — see
// backend src/rag/promptTemplate.ts for why history reloads can't recover it.
export interface Citation {
  chunkId: string;
  pageNumber: number;
  excerpt: string;
  marker?: number;
}

export type MessageRole = "user" | "assistant";

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citedChunkIds: string[];
  createdAt: string;
  citations?: Citation[];
}

// Mirrors backend src/ws/socketServer.ts's send() payloads exactly — one
// shared "ask" question message client->server, three possible
// server->client event shapes. Kept as a discriminated union on `type` so
// TypeScript narrows each branch's fields automatically in the WS message
// handler (useChatSocket.ts), the same reasoning as the hand-maintained
// REST types above.
export interface WsAskMessage {
  type: "ask";
  conversationId: string;
  question: string;
}

export type WsServerEvent =
  | { type: "token"; conversationId: string; text: string }
  | {
      type: "done";
      conversationId: string;
      message: MessageRecord;
      isAnswerable: boolean;
      retrievedChunkCount: number;
      usedChunkCount: number;
      citations: Citation[];
    }
  | { type: "error"; conversationId?: string; error: string };

export interface AskResponse {
  message: MessageRecord;
  isAnswerable: boolean;
  retrievedChunkCount: number;
  usedChunkCount: number;
  citations: Citation[];
}
