import { and, eq, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { db } from "../db/client.js";
import { chunks } from "../db/schema.js";

export type MatchSource = "vector" | "fulltext";

export interface RetrievedChunk {
  id: string;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  // Cosine DISTANCE (0 = identical, 2 = opposite) from the vector leg of the
  // hybrid search. Still meaningful and still used for the relevance cutoff
  // below, but no longer the sole ranking signal — see fuse().
  distance: number;
  // Which retrieval method(s) surfaced this chunk. Exposed mainly so the
  // relevance filter in generateAnswer.ts can treat a full-text hit as
  // evidence of relevance even when the embedding distance alone wouldn't
  // clear the threshold — that gap is exactly what hybrid search exists to
  // close. Also handy to log during eval runs to see which queries actually
  // needed the full-text leg.
  matchedVia: MatchSource[];
}

export const TOP_K = 5;

// Chunks with cosine distance above this AND no full-text match are treated
// as "not actually relevant" and excluded before they ever reach the LLM
// prompt — a deliberate second layer of hallucination defense on top of the
// system prompt's instructions. A full-text hit bypasses this cutoff
// entirely (see fuse() / the filter in generateAnswer.ts): a literal
// keyword/proper-noun match is direct evidence of relevance that embedding
// distance can systematically miss on short, boilerplate-heavy chunks
// (title pages, name/number tables) where the wording doesn't closely echo
// the question.
//
// 0.65 is a reasonable starting point, not empirically tuned — see the
// Phase 6 eval set.
export const MAX_RELEVANT_DISTANCE = 0.65;

// How many candidates each individual retrieval method contributes before
// fusion. Deliberately wider than TOP_K: a chunk that's e.g. the #8 nearest
// vector match but the #1 full-text match still needs to be IN both
// candidate pools for RRF to see it and rank it up.
const CANDIDATE_POOL = 20;

// Standard Reciprocal Rank Fusion constant (Cormack et al.'s original RRF
// paper uses 60). RRF isn't sensitive to precise tuning of this value — it
// just controls how much a #1 rank outweighs a #10 rank when merging two
// independently ranked lists whose raw scores (cosine distance vs. ts_rank)
// aren't on comparable scales and so can't just be averaged directly.
const RRF_K = 60;

interface CandidateRow {
  id: string;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  distance: number;
}

/**
 * Hybrid retrieval: runs pgvector cosine similarity and Postgres full-text
 * search independently, then merges the two ranked lists with Reciprocal
 * Rank Fusion.
 *
 * Why hybrid at all: pure embedding similarity is very good at "what does
 * the text say about topic Y" and noticeably worse at literal
 * keyword/proper-noun/structural lookups ("what is the title", "who is the
 * supervisor", a specific ID number) — the wording of the question and the
 * wording of the answer just don't need to be semantically close for those.
 * Full-text search is the mirror image: great at literal overlap, useless
 * for "what does this mean" style questions. Fusing both catches more of
 * the query distribution than either alone, without having to classify the
 * query type up front.
 *
 * Ownership (does this document belong to this user) is the caller's
 * responsibility, same as before this function had a full-text leg added.
 */
export async function retrieveChunks(
  documentId: string,
  question: string,
  queryEmbedding: number[],
  topK: number = TOP_K
): Promise<RetrievedChunk[]> {
  // .mapWith(Number) both gives us a typed number and guarantees runtime
  // coercion — the pg driver doesn't always return numeric/float columns as
  // JS numbers by default for every type.
  const distance = cosineDistance(chunks.embedding, queryEmbedding).mapWith(Number);

  const vectorRows = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      pageNumber: chunks.pageNumber,
      chunkIndex: chunks.chunkIndex,
      distance,
    })
    .from(chunks)
    .where(and(eq(chunks.documentId, documentId), sql`${chunks.embedding} IS NOT NULL`))
    .orderBy(distance)
    .limit(CANDIDATE_POOL);

  // websearch_to_tsquery (not plainto_tsquery/to_tsquery) because it
  // degrades gracefully on natural-language questions: stopwords are
  // dropped rather than requiring every word to match, and it won't throw
  // on punctuation a strict to_tsquery() call would choke on. If the
  // question is entirely stopwords, websearch_to_tsquery just returns an
  // empty tsquery that matches nothing — a silent empty result, not a
  // thrown error, so no special-casing needed here.
  //
  // to_tsvector('english', content) is computed at query time rather than
  // stored in a generated column — the accompanying migration adds a GIN
  // index on that exact expression, so Postgres can use it without us
  // needing a new schema.ts column or a backfill for existing rows.
  const ftsRows = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      pageNumber: chunks.pageNumber,
      chunkIndex: chunks.chunkIndex,
      distance,
    })
    .from(chunks)
    .where(
      and(
        eq(chunks.documentId, documentId),
        sql`to_tsvector('english', ${chunks.content}) @@ websearch_to_tsquery('english', ${question})`
      )
    )
    .orderBy(
      sql`ts_rank(to_tsvector('english', ${chunks.content}), websearch_to_tsquery('english', ${question})) DESC`
    )
    .limit(CANDIDATE_POOL);

  return fuse(vectorRows, ftsRows, topK);
}

function fuse(vectorRows: CandidateRow[], ftsRows: CandidateRow[], topK: number): RetrievedChunk[] {
  const scored = new Map<string, RetrievedChunk & { rrfScore: number }>();

  function addRanked(rows: CandidateRow[], source: MatchSource) {
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = scored.get(row.id);
      if (existing) {
        existing.rrfScore += contribution;
        if (!existing.matchedVia.includes(source)) existing.matchedVia.push(source);
      } else {
        scored.set(row.id, {
          id: row.id,
          content: row.content,
          pageNumber: row.pageNumber,
          chunkIndex: row.chunkIndex,
          distance: row.distance,
          matchedVia: [source],
          rrfScore: contribution,
        });
      }
    });
  }

  addRanked(vectorRows, "vector");
  addRanked(ftsRows, "fulltext");

  return [...scored.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map((v) => ({
      id: v.id,
      content: v.content,
      pageNumber: v.pageNumber,
      chunkIndex: v.chunkIndex,
      distance: v.distance,
      matchedVia: v.matchedVia,
    }));
}
