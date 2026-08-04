import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { parseCookie as parseCookieHeader } from "cookie";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set (check your .env file)");
}
const JWT_SECRET: string = process.env.JWT_SECRET;

// 10 salt rounds is bcrypt's commonly-cited floor for a reasonable
// cost/security tradeoff in 2026 (each +1 round roughly doubles hashing
// time). bcryptjs (pure JS, no native bindings) is used instead of the
// `bcrypt` package specifically so `npm install` never needs a C++ build
// step on Render's free-tier build image — worth the modest throughput
// cost for a project at this traffic scale.
const SALT_ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface JwtPayload {
  sub: string; // user id
}

// 7 days: long enough that a returning user doesn't get logged out on every
// visit (this is a document Q&A tool people come back to, not a banking
// app), short enough that a leaked cookie doesn't grant indefinite access.
// There's no refresh-token flow — a deliberate scope cut for a portfolio
// project; re-authenticating after 7 days is an acceptable cost. Noted in
// the README as a "what I'd add at scale" item alongside token revocation
// (this scheme has no server-side session store, so a stolen token is valid
// until it expires — nothing short of rotating JWT_SECRET can revoke it
// early).
const TOKEN_TTL = "7d";

export function signToken(userId: string): string {
  const payload: JwtPayload = { sub: userId };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Throws if the token is missing, malformed, or expired. */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export const AUTH_COOKIE_NAME = "docuquery_token";

// SameSite=None is required because the deployed frontend (Vercel) and
// backend (Render) are different origins — SameSite=Lax/Strict would
// silently drop the cookie on cross-site fetches. None requires Secure, so
// this literally cannot work over plain HTTP; both deploy targets serve
// HTTPS by default, and local dev falls back to Lax (see cookieOptions())
// since localhost:5173 -> localhost:4000 across ports still counts as
// cross-origin for CORS purposes but same-site for cookie purposes, so Lax
// works there without needing a self-signed cert.
/**
 * Verifies the auth cookie from a raw `Cookie` header string and returns the
 * user id, or null. Used specifically for the WebSocket upgrade handshake
 * (src/ws/socketServer.ts), which happens before Express's routing/
 * middleware stack — including cookie-parser — ever runs; `req.cookies` from
 * authenticate.ts isn't available there, so the header has to be parsed
 * directly. `authenticate.ts` and this function intentionally share zero
 * code path beyond `verifyToken` itself: keeping the HTTP and WS auth entry
 * points structurally separate (rather than forcing one to call the other
 * through an artificial shim) makes each easy to reason about on its own.
 */
export function userIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const parsed = parseCookieHeader(cookieHeader);
  const token = parsed[AUTH_COOKIE_NAME];
  if (!token) return null;
  try {
    return verifyToken(token).sub;
  } catch {
    return null;
  }
}

export function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? "none" : "lax") as "none" | "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}
