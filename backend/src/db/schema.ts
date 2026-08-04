import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  vector,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// NOTE: citext/pgcrypto/vector extensions are created in the first migration
// (see src/db/migrations/0000_*.sql after `npm run db:generate`), not here —
// Drizzle's schema DSL doesn't manage extensions directly.

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // citext would give case-insensitive uniqueness "for free" at the extension
    // level, but it isn't a first-class Drizzle column type (needs a custom type
    // shim to get real type safety). A functional unique index on lower(email)
    // gives the identical guarantee — one duplicate-account bug class closed —
    // with zero extra machinery. Every login/signup query must also filter on
    // lower(email) to hit this index; that's enforced in the auth layer (Phase 5).
    uniqueIndex("uq_users_email_lower").on(sql`lower(${table.email})`),
  ]
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    status: text("status").notNull().default("pending"),
    pageCount: integer("page_count"),
    errorMessage: text("error_message"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_documents_user_id").on(table.userId),
    check(
      "documents_status_check",
      sql`${table.status} IN ('pending','processing','ready','failed')`
    ),
  ]
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    // nvidia/nemotron-3-embed-1b:free via OpenRouter is 2048-dim (see
    // src/lib/openrouter.ts for the model constant). If you swap embedding
    // providers/models later, this dimension MUST match exactly or inserts
    // fail — pgvector enforces it at the column level. Changing it also
    // needs a migration (see migrations/0002_nemotron_embedding_2048.sql
    // for the precedent) and a full re-embed of existing chunks, since old
    // vectors from a different model aren't comparable to new ones.
    embedding: vector("embedding", { dimensions: 2048 }),
    pageNumber: integer("page_number").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chunks_document_id").on(table.documentId),
    uniqueIndex("uq_chunks_document_chunk_index").on(table.documentId, table.chunkIndex),
    // Vector similarity index (HNSW) is added in a later migration once we've
    // decided index params against real data — see Phase 3 notes.
  ]
);

// Fixed-window rate limiter for the LLM-calling endpoints (ask-question,
// both REST and WebSocket). One row per user, upserted atomically per
// request — see src/lib/rateLimiter.ts for the query. A fixed window is the
// simplest correct thing that doesn't need Redis: this project is
// deliberately Postgres-only (see README tradeoffs section), and a single
// UPSERT...RETURNING is one round trip, same cost as a read-then-write
// would be, but without the read-then-write race. The known fixed-window
// weakness — up to 2x the limit if requests cluster right across a window
// boundary — is an accepted tradeoff for a portfolio project's traffic
// levels; a sliding-window or token-bucket algorithm (typically Redis-
// backed, e.g. via a Lua script for atomicity) is the noted upgrade path.
export const rateLimitWindows = pgTable("rate_limit_windows", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_conversations_user_id").on(table.userId),
    index("idx_conversations_document_id").on(table.documentId),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citedChunkIds: uuid("cited_chunk_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_conversation_id").on(table.conversationId),
    check("messages_role_check", sql`${table.role} IN ('user','assistant')`),
  ]
);
