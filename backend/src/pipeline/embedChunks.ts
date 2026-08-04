import { openrouter, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../lib/openrouter.js";

// The embeddings endpoint accepts an array input, so we send chunks in
// batches rather than one HTTP request per chunk. At ~500 tokens/chunk a
// 50-document-page PDF is roughly 100-150 chunks; one-request-per-chunk would
// mean 100+ round trips for a single upload, each paying full HTTP/TLS
// overhead. Batching cuts that to a handful of requests.
//
// 100 is comfortably under two limits: the per-request 300k summed-token cap
// (100 chunks * ~500 tokens = ~50k) and a reasonable single-response payload
// size (100 * 2048 floats).
const BATCH_SIZE = 100;

export interface EmbeddingResult {
  chunkIndex: number; // echoes the input chunk's own index for zip-back
  embedding: number[];
}

/**
 * Embeds a list of text strings, returning vectors in the same order as the
 * input. Callers pass the chunk's own array position; we don't trust the
 * provider to preserve order and instead re-sort by the `index` field the
 * API returns for each embedding — providers are allowed to parallelize
 * batch items internally and are only contractually required to tag each
 * result with its input position, not to return them pre-sorted.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = new Array(texts.length);

  for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_SIZE) {
    const batch = texts.slice(batchStart, batchStart + BATCH_SIZE);

    const response = await openrouter.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      encoding_format:"float",
    });

    for (const item of response.data) {
      const vector = item.embedding;
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        // Fail loudly rather than silently inserting a mismatched vector —
        // pgvector's fixed-dimension column would reject the insert anyway,
        // but catching it here gives a much clearer error message tied to
        // the actual cause (model/provider drift) instead of a raw SQL error
        // surfacing several layers away from where the mismatch originated.
        throw new Error(
          `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}. ` +
            `Check that EMBEDDING_MODEL (${EMBEDDING_MODEL}) hasn't changed its output size.`
        );
      }
      results[batchStart + item.index] = vector;
    }
  }

  return results;
}
