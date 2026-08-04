import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import type { ErrorRequestHandler } from "express";
import { authenticate } from "./middleware/authenticate.js";
import { authRouter } from "./routes/auth.js";
import { documentsRouter } from "./routes/documents.js";
import { conversationsRouter } from "./routes/conversations.js";

if (!process.env.CORS_ORIGIN) {
  throw new Error(
    "CORS_ORIGIN is not set (check your .env file). A credentialed CORS request " +
      "(cookies) cannot use the wildcard '*' origin — an exact origin is required."
  );
}

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN,
      // Required for the browser to send/receive the httpOnly auth cookie
      // cross-origin (frontend on Vercel, backend on Render). Without this,
      // `fetch(..., { credentials: "include" })` on the client is a no-op —
      // both sides have to opt in.
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Auth routes are intentionally NOT behind `authenticate` as a group —
  // signup/login must be reachable by logged-out clients. GET /me applies
  // `authenticate` itself, inline, since it's the one route in this router
  // that needs a session (see routes/auth.ts).
  app.use("/api/auth", authRouter);

  app.use("/api/documents", authenticate, documentsRouter);
  app.use("/api/conversations", authenticate, conversationsRouter);

  // 404 for anything unmatched
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Multer errors (file too large, wrong field name) and our own
    // fileFilter rejection (wrong mimetype) are client mistakes, not server
    // failures — they belong in the 400 family, not falling through to a
    // generic 500 that would misleadingly suggest something broke server-side.
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof Error && err.message === "Only PDF files are accepted") {
      return res.status(400).json({ error: err.message });
    }

    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
