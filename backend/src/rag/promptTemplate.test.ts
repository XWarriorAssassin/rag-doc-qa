import { describe, it, expect } from "vitest";
import { buildPrompt, parseCitations, NO_ANSWER_SENTINEL } from "./promptTemplate.js";
import type { RetrievedChunk } from "./retrieveChunks.js";

function chunk(id: string, pageNumber: number, content: string): RetrievedChunk {
  return { id, content, pageNumber, chunkIndex: 0, distance: 0.1, matchedVia: ["vector"] };
}

describe("buildPrompt", () => {
  it("numbers excerpts starting at 1, in the order given, independent of chunk id", () => {
    const chunks = [chunk("uuid-b", 5, "second"), chunk("uuid-a", 2, "first")];
    const { promptChunks, userPrompt } = buildPrompt("What happened?", chunks);

    expect(promptChunks[0]).toMatchObject({ id: "uuid-b", displayNumber: 1 });
    expect(promptChunks[1]).toMatchObject({ id: "uuid-a", displayNumber: 2 });
    expect(userPrompt).toContain("[1] (page 5)");
    expect(userPrompt).toContain("[2] (page 2)");
  });

  it("includes the question in the user prompt", () => {
    const { userPrompt } = buildPrompt("How many widgets shipped?", [chunk("a", 1, "content")]);
    expect(userPrompt).toContain("How many widgets shipped?");
  });

  it("instructs the model to emit the sentinel when it can't answer", () => {
    const { systemPrompt } = buildPrompt("irrelevant", []);
    expect(systemPrompt).toContain(NO_ANSWER_SENTINEL);
  });
});

describe("parseCitations", () => {
  it("treats an exact sentinel match as unanswerable, with no citations", () => {
    const { promptChunks } = buildPrompt("q", [chunk("a", 1, "content")]);
    const result = parseCitations(NO_ANSWER_SENTINEL, promptChunks);
    expect(result.isAnswerable).toBe(false);
    expect(result.citedChunkIds).toEqual([]);
    expect(result.citations).toEqual([]);
  });

  it("extracts and resolves [n] markers back to real chunk ids", () => {
    const { promptChunks } = buildPrompt("q", [
      chunk("chunk-uuid-1", 3, "The warranty period is 12 months."),
      chunk("chunk-uuid-2", 7, "Returns are accepted within 30 days."),
    ]);

    const result = parseCitations("The warranty is 12 months [1], and returns take 30 days [2].", promptChunks);

    expect(result.isAnswerable).toBe(true);
    expect(result.citedChunkIds).toEqual(["chunk-uuid-1", "chunk-uuid-2"]);
    expect(result.citations.map((c) => c.marker)).toEqual([1, 2]);
    expect(result.citations[0]).toMatchObject({ chunkId: "chunk-uuid-1", pageNumber: 3 });
  });

  it("de-duplicates repeated citations to the same marker", () => {
    const { promptChunks } = buildPrompt("q", [chunk("chunk-uuid-1", 1, "fact")]);
    const result = parseCitations("It's true [1], really [1], definitely [1].", promptChunks);
    expect(result.citedChunkIds).toEqual(["chunk-uuid-1"]);
  });

  it("sorts citations ascending by marker regardless of mention order in prose", () => {
    const { promptChunks } = buildPrompt("q", [
      chunk("c1", 1, "a"),
      chunk("c2", 2, "b"),
      chunk("c3", 3, "c"),
    ]);
    const result = parseCitations("As shown [3], and also [1], plus [2].", promptChunks);
    expect(result.citations.map((c) => c.marker)).toEqual([1, 2, 3]);
  });

  it("silently drops a hallucinated citation number outside the given range", () => {
    const { promptChunks } = buildPrompt("q", [chunk("c1", 1, "only one excerpt")]);
    const result = parseCitations("Per the document [1] and also [7].", promptChunks);
    expect(result.citedChunkIds).toEqual(["c1"]);
    expect(result.citations).toHaveLength(1);
  });

  it("truncates long excerpts with an ellipsis, leaves short ones intact", () => {
    const shortContent = "Short fact.";
    const longContent = "x".repeat(300);
    const { promptChunks } = buildPrompt("q", [chunk("c1", 1, shortContent), chunk("c2", 2, longContent)]);

    const result = parseCitations("Short [1] and long [2].", promptChunks);
    const shortCitation = result.citations.find((c) => c.marker === 1);
    const longCitation = result.citations.find((c) => c.marker === 2);

    expect(shortCitation?.excerpt).toBe(shortContent);
    expect(longCitation?.excerpt.endsWith("…")).toBe(true);
    expect(longCitation?.excerpt.length).toBeLessThan(longContent.length);
  });

  it("treats a real answer with zero citation markers as answerable but uncited", () => {
    const { promptChunks } = buildPrompt("q", [chunk("c1", 1, "content")]);
    const result = parseCitations("This is a plain answer with no bracket markers.", promptChunks);
    expect(result.isAnswerable).toBe(true);
    expect(result.citedChunkIds).toEqual([]);
  });
});
