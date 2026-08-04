import { Tiktoken } from "js-tiktoken";
import cl100kRanks from "js-tiktoken/ranks/cl100k_base";
import type { ExtractedPage } from "./extractText.js";

// cl100k_base is the tokenizer OpenAI's embedding models (including
// text-embedding-3-small) actually use. Counting words or characters as a
// proxy for tokens is a common shortcut, but it drifts enough (especially on
// technical text with lots of punctuation/numbers) that chunk sizes end up
// unpredictable. Loading the real encoder costs one dependency and gives
// exact counts.
const encoder = new Tiktoken(cl100kRanks);

export interface Chunk {
  content: string;
  pageNumber: number;
  chunkIndex: number;
  tokenCount: number;
}

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

/**
 * Chunks extracted pages into ~500-token windows with ~50-token overlap.
 *
 * Chunking is done per-page rather than concatenating the whole document
 * first: this keeps each chunk's `page_number` unambiguous. The tradeoff is
 * that a chunk never spans a page boundary, so content split across a page
 * break (e.g. a sentence cut off at the bottom of a page) ends up in two
 * chunks instead of one contiguous chunk. That's an acceptable loss for
 * citation accuracy — knowing which page an answer came from matters more
 * for this product than never splitting a sentence.
 */
export function chunkText(pages: ExtractedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    if (!page.text) continue;

    const tokens = encoder.encode(page.text);
    if (tokens.length === 0) continue;

    let start = 0;
    while (start < tokens.length) {
      const end = Math.min(start + TARGET_TOKENS, tokens.length);
      const windowTokens = tokens.slice(start, end);
      const content = encoder.decode(windowTokens).trim();

      if (content.length > 0) {
        chunks.push({
          content,
          pageNumber: page.pageNumber,
          chunkIndex: globalChunkIndex,
          tokenCount: windowTokens.length,
        });
        globalChunkIndex++;
      }

      if (end === tokens.length) break;
      // Step forward by (target - overlap), not by target, so the next
      // window re-includes the trailing OVERLAP_TOKENS of this one.
      start += TARGET_TOKENS - OVERLAP_TOKENS;
    }
  }

  return chunks;
}
