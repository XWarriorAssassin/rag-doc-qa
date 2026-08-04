import type { RetrievedChunk } from "./retrieveChunks.js";

// A fixed, model-emitted sentinel we can detect deterministically. Relying on
// free-form phrasing ("I don't know", "Sorry, I can't find that...") to
// decide whether to show the app's fallback UI is fragile — models phrase
// refusals inconsistently, and matching against a growing list of possible
// refusal strings is a losing game. Instructing the model to emit one exact
// token when it can't answer, and checking for that token in code, is
// deterministic either way: found or not found.
export const NO_ANSWER_SENTINEL = "NOT_FOUND_IN_DOCUMENT";

const SYSTEM_PROMPT = `You are a document question-answering assistant. You answer questions using ONLY the numbered context excerpts provided below — never your own general knowledge, even if you happen to know the answer from training.

Rules:
1. Base your answer strictly on the provided context excerpts. Do not add information that isn't in them.
2. When you use information from an excerpt, cite it inline with its number in square brackets, e.g. [1] or [2][3]. Cite every excerpt your answer actually relies on.
3. If the context excerpts do not contain enough information to answer the question, respond with exactly this text and nothing else: ${NO_ANSWER_SENTINEL}
4. Do not guess, speculate, or fill gaps with plausible-sounding information not present in the excerpts.`;

export interface PromptChunk extends RetrievedChunk {
  // 1-indexed position in the prompt's numbered excerpt list. This is the
  // number the model is instructed to cite — deliberately NOT the chunk's
  // real database id, because asking a model to reproduce a UUID correctly
  // in its output (rather than just echoing a small integer we handed it)
  // is an unnecessary reliability risk for zero benefit; we map the number
  // back to the real chunk id ourselves in parseCitations.
  displayNumber: number;
}

export function buildPrompt(
  question: string,
  retrievedChunks: RetrievedChunk[]
): { systemPrompt: string; userPrompt: string; promptChunks: PromptChunk[] } {
  const promptChunks: PromptChunk[] = retrievedChunks.map((chunk, i) => ({
    ...chunk,
    displayNumber: i + 1,
  }));

  const contextBlock = promptChunks
    .map((c) => `[${c.displayNumber}] (page ${c.pageNumber})\n${c.content}`)
    .join("\n\n");

  const userPrompt = `Context excerpts:\n\n${contextBlock}\n\nQuestion: ${question}`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt, promptChunks };
}

// A single citation, resolved from a [n] marker back to the real chunk it
// points at. `marker` is the exact number the model printed inline (e.g. the
// "2" in "[2]") — the frontend needs this to turn inline brackets into
// clickable chips that open the right excerpt, not just a bag of chunk ids
// with no positional meaning.
export interface Citation {
  marker: number;
  chunkId: string;
  pageNumber: number;
  excerpt: string;
}

export interface ParsedAnswer {
  isAnswerable: boolean;
  answerText: string;
  citedChunkIds: string[];
  citations: Citation[];
}

const EXCERPT_MAX_CHARS = 220;

/**
 * Parses the model's raw completion text against the promptChunks it was
 * given, extracting which numbered citations it actually used and mapping
 * them back to real chunk UUIDs.
 *
 * Returns both `citedChunkIds` (flat list, ordered by ascending marker —
 * this is what persists to messages.cited_chunk_ids per the fixed schema)
 * and `citations` (marker -> chunk detail, richer but NOT persisted). The
 * split exists because the schema stores only uuid[], with no room for the
 * marker number or page/excerpt alongside it. Callers that need the marker
 * mapping (fresh answers, right after generation) get it from `citations`;
 * reloading history later re-derives a page/excerpt list from the persisted
 * ids alone, without marker positions — see conversations route.
 */
export function parseCitations(rawCompletion: string, promptChunks: PromptChunk[]): ParsedAnswer {
  const trimmed = rawCompletion.trim();

  if (trimmed === NO_ANSWER_SENTINEL) {
    return { isAnswerable: false, answerText: "", citedChunkIds: [], citations: [] };
  }

  const citedNumbers = new Set<number>();
  const citationPattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationPattern.exec(trimmed)) !== null) {
    citedNumbers.add(Number(match[1]));
  }

  const chunkByNumber = new Map(promptChunks.map((c) => [c.displayNumber, c]));

  // Sorted ascending (not insertion/appearance order) so citedChunkIds and
  // citations are deterministic regardless of the order the model happened
  // to mention them in prose.
  const sortedNumbers = [...citedNumbers].sort((a, b) => a - b);

  const citations: Citation[] = sortedNumbers
    // A model can hallucinate a citation number outside the range it was
    // given (e.g. cites [7] when only 5 excerpts existed) — silently drop
    // those rather than crash or store a bogus reference.
    .filter((n) => chunkByNumber.has(n))
    .map((n) => {
      const chunk = chunkByNumber.get(n)!;
      return {
        marker: n,
        chunkId: chunk.id,
        pageNumber: chunk.pageNumber,
        excerpt:
          chunk.content.length > EXCERPT_MAX_CHARS
            ? chunk.content.slice(0, EXCERPT_MAX_CHARS).trim() + "…"
            : chunk.content,
      };
    });

  const citedChunkIds = citations.map((c) => c.chunkId);

  return { isAnswerable: true, answerText: trimmed, citedChunkIds, citations };
}
