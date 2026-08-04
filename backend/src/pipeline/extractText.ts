// pdfjs-dist ships a browser build (uses DOM APIs like Canvas/Image that don't
// exist in Node) and a "legacy" build meant for non-browser environments. The
// legacy entrypoint is the one that works here — importing the default
// `pdfjs-dist` entry would fail at runtime in Node.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";

export interface ExtractedPage {
  pageNumber: number; // 1-indexed, matches how humans reference PDF pages
  text: string;
}

export interface ExtractedDocument {
  pageCount: number;
  pages: ExtractedPage[];
}

/**
 * Extracts text per-page from a PDF buffer. We need page-level granularity
 * (not just the whole-document text pdf-parse-style libraries give you)
 * because the `chunks.page_number` column is part of the citation contract —
 * an answer has to point back to a specific page, not just "somewhere in
 * the document."
 */
export async function extractText(buffer: Buffer): Promise<ExtractedDocument> {
  const data = new Uint8Array(buffer);

  const loadingTask = getDocument({
    data,
    // pdfjs tries to load standard fonts/cmaps from disk by default in Node,
    // which we haven't vendored. Text extraction doesn't need glyph
    // rendering, so this is safe to disable rather than ship font assets.
    useSystemFonts: true,
  });

  const doc = await loadingTask.promise;
  const pages: ExtractedPage[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    // content.items is a mix of TextItem (has .str) and TextMarkedContent
    // (no .str) — pdf.js emits marked-content markers for tagged PDFs.
    // Filter to text items only.
    const text = content.items
      .filter((item): item is TextItem => "str" in item)
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    pages.push({ pageNumber, text });
    page.cleanup();
  }

  // destroy() lives on the loading task (aborts network requests, tears
  // down the worker), not on the document proxy returned by its .promise —
  // a common mix-up since both are informally called "the document."
  await loadingTask.destroy();

  return { pageCount: doc.numPages, pages };
}
