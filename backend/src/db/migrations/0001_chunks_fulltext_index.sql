-- Hand-authored migration (no schema.ts change) supporting hybrid retrieval.
-- Computes to_tsvector('english', content) at query time rather than storing
-- it in a generated column — this index lets Postgres use that computation
-- efficiently without a new chunks column or a backfill for existing rows.
-- Must match the exact expression used in src/rag/retrieveChunks.ts's
-- WHERE/ORDER BY clauses, or Postgres won't recognize it as index-eligible.
CREATE INDEX IF NOT EXISTS idx_chunks_content_fts
  ON chunks
  USING GIN (to_tsvector('english', content));
