import { Router } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword, signToken, cookieOptions, AUTH_COOKIE_NAME } from "../lib/auth.js";
import { authenticate } from "../middleware/authenticate.js";

export const authRouter = Router();

// Bcrypt has no practical upper length limit issue below 72 bytes (its
// actual input cap), so 72 is enforced here rather than left to bcrypt to
// silently truncate — silent truncation would mean two different long
// passwords hash identically, a subtle correctness bug users would never
// notice until it mattered.
const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(72),
});

function publicUser(user: { id: string; email: string; createdAt: Date }) {
  // Never send passwordHash to the client, even inside a 201/200 body that
  // presumably only the owning user sees — defense in depth against a
  // future route accidentally spreading the full row into a response.
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

// POST /api/auth/signup
authRouter.post("/signup", async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    // Case-insensitive check via lower(email), matching the DB's unique
    // index (uq_users_email_lower) — checking with a plain `eq(users.email,
    // email)` here would let "Bob@x.com" and "bob@x.com" both register,
    // then have the SECOND insert fail with an opaque Postgres unique-
    // constraint error instead of a clean 409.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(password);
    const [created] = await db.insert(users).values({ email, passwordHash }).returning();
    if (!created) throw new Error("Failed to create user");

    const token = signToken(created.id);
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
    res.status(201).json(publicUser(created));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      // Same 400 shape as signup's validation failure — deliberately not
      // distinguishing "bad format" from "wrong password" at this stage,
      // since that distinction leaks nothing useful and this branch never
      // reaches the DB anyway.
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    // Identical error for "no such user" and "wrong password" — a
    // distinguishable response is a user-enumeration side channel (an
    // attacker could otherwise probe which emails have accounts).
    const invalidCredentials = () => res.status(401).json({ error: "Invalid email or password" });

    if (!user) return invalidCredentials();

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return invalidCredentials();

    const token = signToken(user.id);
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
authRouter.post("/logout", (_req, res) => {
  // clearCookie needs the same attributes (path/sameSite/secure) used to
  // set it, or browsers won't match it and it'll linger — httpOnly doesn't
  // matter for clearing since we're not reading it, but the rest do.
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
  res.status(204).send();
});

// GET /api/auth/me
// Lets the frontend check "is there a valid session" on page load without
// duplicating JWT-verification logic client-side (which it couldn't do
// anyway — the token is httpOnly and invisible to JS by design).
authRouter.get("/me", authenticate, async (req, res, next) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, req.userId)).limit(1);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});
