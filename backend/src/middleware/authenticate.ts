import type { Request, Response, NextFunction } from "express";
import { AUTH_COOKIE_NAME, verifyToken } from "../lib/auth.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

/**
 * Replaces the Phase 1-4 `resolveUser` dev-user stand-in. Every downstream
 * route was already written against `req.userId` set by middleware, so this
 * swap is the entire migration to real auth — no route file changes needed.
 *
 * Reads the JWT from the httpOnly cookie (never from a header/body — that's
 * the whole point of httpOnly: client-side JS, including this app's own
 * frontend code, can't read or forge it). `cookie-parser` populates
 * `req.cookies` before this middleware runs (see app.ts).
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    // Covers both a malformed token and an expired one (jwt.verify throws
    // for both) — same response either way, since the client's remedy is
    // identical: log in again.
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
