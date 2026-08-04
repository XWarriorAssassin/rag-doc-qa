import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { documents, chunks } from "../db/schema.js";
import { extractText } from "./extractText.js";
import { chunkText } from "./chunkText.js";
import { embedTexts } from "./embedChunks.js";

/**
 * Runs the full pipeline for one uploaded document: extract → chunk → embed
 * → persist, updating `documents.status` as it progresses so the frontend
 * can poll GET /api/documents/:id and show upload progress.
 *
 * Called fire-and-forget from the upload route (not awaited by the HTTP
 * response) — see the route for why. Every exit path from this function
 * writes a final status ('ready' or 'failed'); it must never throw past its
 * own boundary, or a document would be stuck in 'processing' forever with no
 * way for the user to know it died. That's the one invariant this function
 * exists to guarantee.
 */
export async function processDocument(documentId: string): Promise<void> {
  try {
    await db
      .update(documents)
      .set({ status: "processing" })
      .where(eq(documents.id, documentId));

    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      throw new Error(`Document ${documentId} not found`);
    }

    const fileBuffer = await fs.readFile(doc.storagePath);
    const extracted = await extractText(fileBuffer);

    if (extracted.pages.every((p) => !p.text)) {
      // Common for scanned/image-only PDFs with no text layer. We don't do
      // OCR in this pipeline (a deliberate scope cut — see README "what I'd
      // do differently at scale"), so this is a genuine failure, not a bug.
      throw new Error(
        "No extractable text found in PDF. Scanned or image-only PDFs aren't supported (no OCR step)."
      );
    }

    const documentChunks = chunkText(extracted.pages);

    if (documentChunks.length === 0) {
      throw new Error("Text was extracted but produced no chunks.");
    }

    const embeddings = await embedTexts(documentChunks.map((c) => c.content));

    // Single transaction: either every chunk for this document lands, or
    // none do. Partial chunk sets would silently degrade retrieval quality
    // (missing pages) without the document's `status` reflecting that
    // anything is wrong — worse than an outright failed status.
    await db.transaction(async (tx) => {
      await tx.insert(chunks).values(
        documentChunks.map((chunk, i) => ({
          documentId,
          content: chunk.content,
          embedding: embeddings[i],
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount,
        }))
      );

      await tx
        .update(documents)
        .set({ status: "ready", pageCount: extracted.pageCount, errorMessage: null })
        .where(eq(documents.id, documentId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    console.error(`Document processing failed for ${documentId}:`, err);

    // Best-effort status write. If this update itself fails (e.g. DB is
    // down), there's nothing further we can do from inside a fire-and-forget
    // background task — logging is the last line of defense.
    await db
      .update(documents)
      .set({ status: "failed", errorMessage: message })
      .where(eq(documents.id, documentId))
      .catch((updateErr) => {
        console.error(`Failed to write failed-status for ${documentId}:`, updateErr);
      });
  }
}
