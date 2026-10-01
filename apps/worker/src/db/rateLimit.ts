/**
 * Basic per-project rate limiting (plan §7 Phase 6): a fixed-window counter in
 * D1, keyed by "{projectId}:{action}".
 *
 * Why D1 and not the beta Workers ratelimit binding: the binding does not work
 * in local `wrangler dev`, so dev and prod would behave differently. A D1
 * counter is identical everywhere.
 *
 * Precision is NOT a goal ("basic rate limit"): a single-statement upsert
 * minimizes races, but under true concurrency two requests can still pass
 * together; the window is fixed (not sliding), and the counter never expires
 * by itself — stale windows simply reset on the next hit.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { rateLimits } from "./schema";
import { CodedHTTPException } from "../routes/errors";

/** Idea generation costs provider credits: 5 calls per minute per project. */
export const IDEAS_GENERATE_LIMIT = { action: "ideas_generate", limit: 5, windowMs: 60_000 } as const;

/** The cheap probe endpoint: 10 calls per minute per project. */
export const AI_CONFIG_TEST_LIMIT = { action: "ai_config_test", limit: 10, windowMs: 60_000 } as const;

/**
 * Count one request against the project's window for `action` and throw a 429
 * CodedHTTPException (code "RateLimited", Retry-After set to the remaining
 * seconds of the window) when the limit is exceeded.
 *
 * The upsert is one statement: on conflict, the CASE resets a window that has
 * aged out (`excluded.window_start` is the proposed `now`), otherwise it bumps
 * the counter. The RETURNING row is the post-upsert state.
 */
export async function enforceRateLimit(
  db: Db,
  projectId: string,
  action: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const key = `${projectId}:${action}`;
  const now = Date.now();
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`CASE WHEN excluded.window_start - ${rateLimits.windowStart} >= ${windowMs}
                             THEN excluded.window_start ELSE ${rateLimits.windowStart} END`,
        count: sql`CASE WHEN excluded.window_start - ${rateLimits.windowStart} >= ${windowMs}
                        THEN 1 ELSE ${rateLimits.count} + 1 END`,
      },
    })
    .returning({ windowStart: rateLimits.windowStart, count: rateLimits.count });

  if (row && row.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000));
    throw new CodedHTTPException(
      429,
      "Too many requests — please wait a moment and try again.",
      "RateLimited",
      { "Retry-After": String(retryAfterSeconds) },
    );
  }
}
