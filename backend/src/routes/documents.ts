import fs from "node:fs/promises";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { documents } from "../db/schema.js";
import { storagePathFor } from "../lib/storage.js";
import { processDocument } from "../pipeline/processDocument.js";

export const documentsRouter = Router();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — generous for text-heavy
// PDFs, tight enough that one upload can't tie up disk/memory on the free
// hosting tier this is deployed to.

// Buffered in memory (not streamed to disk directly by multer) because we
// need the whole file before we can pick its final on-disk path — the path
// is derived from the DB-generated document id, and we control that
// generation, not multer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF files are accepted"));
      return;
    }
    cb(null, true);
  },
});

const updateDocumentSchema = z.object({
  filename: z.string().min(1).max(255).optional(),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  pageCount: z.number().int().positive().optional(),
  errorMessage: z.string().optional(),
});

// POST /api/documents/upload
// The only way to create a document. An earlier Phase-1 version of this
// router had a separate `POST /` that created a metadata-only row from a
// client-supplied storagePath, before file upload existed. Removed in
// Phase 5: with real multi-user auth in place, a client-controlled
// storagePath is a real arbitrary-file-delete vector (DELETE below passes
// it straight to fs.unlink), and the route had already been fully
// superseded by /upload — the frontend never called it.
// Accepts a PDF file directly (multipart/form-data, field name "file"),
// creates the document row, writes the file to disk, and kicks off the
// extract/chunk/embed pipeline in the background.
//
// This intentionally does NOT await processDocument() before responding.
// A real PDF can take anywhere from a couple seconds to 20-30s to extract,
// chunk, and embed (embedding calls dominate — one or more round trips to
// OpenRouter). Blocking the HTTP response on that would mean either a very
// long-hanging request (bad UX, and many free-tier hosts/proxies will time
// it out around 30s) or the frontend needing a separate polling loop anyway
// once you hit larger documents. Since the frontend already needs to poll
// GET /api/documents/:id to show "processing" -> "ready" status transitions
// (this is a portfolio project, not a system with a job queue + websocket
// push), returning 202 immediately and letting the client poll from the
// start is simpler than half-blocking and switching strategies later.
//
// The tradeoff: if the server process restarts mid-processing, the document
// is stuck in "processing" forever with no automatic retry. At interview-
// discussion scale that's acceptable; at real scale this is exactly the job
// a queue (BullMQ + Redis, SQS, etc.) exists to solve — noted in the README.
documentsRouter.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
    }

    const [created] = await db
      .insert(documents)
      .values({
        userId: req.userId,
        filename: req.file.originalname,
        // Placeholder path, immediately overwritten below once we have the
        // generated id — storagePath is NOT NULL, so we can't insert without
        // some value first, and the id (part of the real path) only exists
        // after this insert.
        storagePath: "pending",
        status: "pending",
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create document record");
    }

    const finalPath = storagePathFor(req.userId, created.id, req.file.originalname);
    await fs.mkdir(finalPath.substring(0, finalPath.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(finalPath, req.file.buffer);

    await db.update(documents).set({ storagePath: finalPath }).where(eq(documents.id, created.id));

    // Fire-and-forget. Errors inside processDocument are caught internally
    // and written to documents.status/error_message — see that module's
    // docstring for why it must never throw past its own boundary.
    void processDocument(created.id);

    res.status(202).json({ ...created, storagePath: finalPath });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents
documentsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(documents)
      .where(eq(documents.userId, req.userId))
      .orderBy(documents.uploadedAt);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id
documentsRouter.get("/:id", async (req, res, next) => {
  try {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.userId)))
      .limit(1);

    if (!doc) {
      // Same 404 whether the document doesn't exist or belongs to someone else —
      // never leak which case it is, that's an ownership-probing side channel.
      return res.status(404).json({ error: "Document not found" });
    }

    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/documents/:id
documentsRouter.patch("/:id", async (req, res, next) => {
  try {
    const parsed = updateDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const [updated] = await db
      .update(documents)
      .set(parsed.data)
      .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.userId)))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/documents/:id
documentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const [deleted] = await db
      .delete(documents)
      .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.userId)))
      .returning({ id: documents.id, storagePath: documents.storagePath });

    if (!deleted) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Chunks are removed automatically via the DB-level ON DELETE CASCADE on
    // chunks.document_id — no application code needed for that. The file on
    // disk is a separate resource the DB doesn't know about, so it needs
    // explicit cleanup here. Best-effort: if the row is gone but the file
    // delete fails (e.g. already missing), that's an orphaned file, not a
    // correctness problem — it can't be queried or served since nothing
    // references it anymore. Log and move on rather than failing the request
    // over a resource the user can no longer even see.
    if (deleted.storagePath && deleted.storagePath !== "pending") {
      await fs.unlink(deleted.storagePath).catch((err) => {
        console.error(`Failed to delete file for document ${deleted.id}:`, err);
      });
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
