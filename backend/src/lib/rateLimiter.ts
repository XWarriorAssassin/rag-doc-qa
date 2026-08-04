import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

// This project runs entirely on OpenRouter's free-tier models, which carry
// their own low request-per-minute caps upstream. This app-level limit is
// deliberately set well under a typical free-tier ceiling — its job isn't
// to be the primary defense (OpenRouter itself is), it's to fail fast with
// a clear per-user message before a burst of clicks turns into a wall of
// upstream 429s that would otherwise surface as confusing generic errors.
const LIMIT = 10;
const WINDOW_MS = 60_000; // 1 minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Atomically increments the caller's request count for the current fixed
 * window, creating the row on first use. One round trip: the UPSERT's
 * RETURNING clause hands back the post-increment count, so there's no
 * separate read to decide allow/deny — a read-then-write version of this
 * would race under concurrent requests from the same user (e.g. two browser
 * tabs firing at once), letting both through even at the limit.
 *
 * Window rollover is expressed inline in the SQL (not computed in JS and
 * passed in) so "is this row's window still current" and "the current
 * time" are evaluated by the same `now()` call inside one statement —
 * avoids any clock-skew edge case between the app server and Postgres.
 */
export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const windowMs = WINDOW_MS;

  const rows = await db.execute<{ request_count: number; window_start: Date }>(sql`
    INSERT INTO rate_limit_windows (user_id, window_start, request_count)
    VALUES (${userId}, now(), 1)
    ON CONFLICT (user_id) DO UPDATE SET
      request_count = CASE
        WHEN rate_limit_windows.window_start > now() - (${windowMs}::text || ' milliseconds')::interval
        THEN rate_limit_windows.request_count + 1
        ELSE 1
      END,
      window_start = CASE
        WHEN rate_limit_windows.window_start > now() - (${windowMs}::text || ' milliseconds')::interval
        THEN rate_limit_windows.window_start
        ELSE now()
      END
    RETURNING request_count, window_start
  `);

  const row = rows.rows[0];
  if (!row) throw new Error("Rate limit upsert returned no row");

  const count = Number(row.request_count);
  const windowStart = new Date(row.window_start).getTime();
  const retryAfterMs = Math.max(0, windowStart + windowMs - Date.now());

  return {
    allowed: count <= LIMIT,
    remaining: Math.max(0, LIMIT - count),
    retryAfterMs,
  };
}
