import { describe, it, expect, beforeEach } from "vitest";

// auth.ts throws at import time if JWT_SECRET is unset (fail-fast pattern —
// see the module itself), so it has to be set before the dynamic import
// below runs, not just before the test body.
process.env.JWT_SECRET = "test-secret-for-vitest-only";

const { hashPassword, verifyPassword, signToken, verifyToken, cookieOptions, AUTH_COOKIE_NAME } = await import(
  "./auth.js"
);

describe("password hashing", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt), both still valid", async () => {
    const hashA = await hashPassword("same password");
    const hashB = await hashPassword("same password");
    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword("same password", hashA)).toBe(true);
    expect(await verifyPassword("same password", hashB)).toBe(true);
  });
});

describe("JWT sign/verify", () => {
  it("round-trips a user id through sign then verify", () => {
    const token = signToken("user-uuid-123");
    const payload = verifyToken(token);
    expect(payload.sub).toBe("user-uuid-123");
  });

  it("rejects a tampered token", () => {
    const token = signToken("user-uuid-123");
    const tampered = token.slice(0, -2) + "xx";
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects a garbage string", () => {
    expect(() => verifyToken("not-a-real-jwt")).toThrow();
  });
});

describe("cookieOptions", () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("uses SameSite=Lax and Secure=false in development (same-site localhost, no HTTPS)", () => {
    process.env.NODE_ENV = "development";
    const opts = cookieOptions();
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false);
  });

  it("uses SameSite=None and Secure=true in production (cross-origin Vercel <-> Render)", () => {
    process.env.NODE_ENV = "production";
    const opts = cookieOptions();
    expect(opts.sameSite).toBe("none");
    expect(opts.secure).toBe(true);
  });

  it("is always httpOnly, regardless of environment", () => {
    process.env.NODE_ENV = "production";
    expect(cookieOptions().httpOnly).toBe(true);
    process.env.NODE_ENV = "development";
    expect(cookieOptions().httpOnly).toBe(true);
  });
});

describe("AUTH_COOKIE_NAME", () => {
  it("is a non-empty, stable cookie name", () => {
    expect(typeof AUTH_COOKIE_NAME).toBe("string");
    expect(AUTH_COOKIE_NAME.length).toBeGreaterThan(0);
  });
});
