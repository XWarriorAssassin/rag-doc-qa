import { describe, it, expect } from "vitest";
import { chunkText } from "./chunkText.js";
import type { ExtractedPage } from "./extractText.js";

function page(pageNumber: number, text: string): ExtractedPage {
  return { pageNumber, text };
}

describe("chunkText", () => {
  it("returns a single chunk for text shorter than the target window", () => {
    const chunks = chunkText([page(1, "Hello world, this is a short document.")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("Hello world");
    expect(chunks[0]?.pageNumber).toBe(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
  });

  it("splits long text into multiple chunks with overlapping content at the boundary", () => {
    // ~2000 words, comfortably past the ~500-token target window.
    const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText([page(1, longText)]);

    expect(chunks.length).toBeGreaterThan(1);

    // The step size between windows is (target - overlap tokens), so the
    // tail of chunk N should reappear at the head of chunk N+1 — that's the
    // entire point of overlap: a fact split across a chunk boundary still
    // appears intact in at least one chunk instead of being cut in half.
    const firstWords = chunks[0]!.content.trim().split(/\s+/);
    const secondWords = chunks[1]!.content.trim().split(/\s+/);
    const lastWordOfFirst = firstWords[firstWords.length - 1];
    expect(secondWords).toContain(lastWordOfFirst);
  });

  it("assigns sequential, zero-based chunkIndex across the whole document, not per page", () => {
    const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText([page(1, longText), page(2, "A short second page.")]);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
    // The short second page's content should land in exactly one chunk,
    // tagged with page 2 — confirms chunking never spans a page boundary.
    const page2Chunks = chunks.filter((c) => c.pageNumber === 2);
    expect(page2Chunks).toHaveLength(1);
    expect(page2Chunks[0]?.content).toContain("short second page");
  });

  it("skips pages with empty text instead of producing empty chunks", () => {
    const chunks = chunkText([page(1, ""), page(2, "   "), page(3, "Real content here.")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.pageNumber).toBe(3);
  });

  it("returns no chunks for a document with no extractable text", () => {
    expect(chunkText([page(1, ""), page(2, "")])).toHaveLength(0);
  });
});
