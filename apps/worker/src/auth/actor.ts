import { eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import type { WorkerEnv } from "../env";
import { CodedHTTPException } from "../routes/errors";
import { resolveSession, SESSION_COOKIE } from "./sessions";

export type ProjectRole = "owner" | "editor";

export type Actor = {
  userId: string;
  email: string;
  /** Role in the project a request targets; routes read it from requireProject. */
  projectRole: ProjectRole | null;
};

/**
 * Hono env used across the API: worker bindings + request-scoped actor.
 * WorkerEnv (Env + required ENCRYPTION_KEY secret) makes tsc enforce that the
 * whole app assumes the secret exists; see src/env.ts.
 */
export type AppEnv = { Bindings: WorkerEnv; Variables: { actor: Actor } };

const DEFAULT_DEV_EMAIL = "dev@postgavel.local";

/**
 * API paths reachable without an actor: the health probe and the two
 * credential endpoints (register/login authenticate the request themselves).
 * GET /api/auth/me and /api/auth/logout go through the gate like everything
 * else, so they always answer from a real session.
 */
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth/register", "/api/auth/login"]);

/**
 * Identity resolution (plan §4): the `pg_session` cookie → sessions row
 * (looked up by SHA-256 of the token) → user. Only when DEV_AUTH=1 (a var set
 * in .dev.vars for local API testing, never in production) does the old
 * X-Dev-User header still resolve a user, falling back to the fixed dev
 * account. No route may trust client-supplied user ids.
 *
 * Without an actor: public API paths continue with the actor unset; every
 * other /api/* path gets the 401 error envelope; non-API paths fall through
 * to the static assets layer.
 */
export const resolveActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const resolved = await resolveSession(getDb(c.env), token);
    if (resolved) {
      const [user] = await getUserById(getDb(c.env), resolved.userId);
      if (user) {
        c.set("actor", { userId: user.id, email: user.email, projectRole: null });
        await next();
        return;
      }
    }
  }

  if (c.env.DEV_AUTH === "1") {
    const email = (c.req.header("X-Dev-User") ?? "").trim().toLowerCase() || DEFAULT_DEV_EMAIL;
    const user = await findOrCreateUser(getDb(c.env), email, email === DEFAULT_DEV_EMAIL ? "Dev User" : null);
    c.set("actor", { userId: user.id, email: user.email, projectRole: null });
    await next();
    return;
  }

  if (c.req.path.startsWith("/api/") && !PUBLIC_API_PATHS.has(c.req.path)) {
    throw new CodedHTTPException(401, "Please sign in to continue.", "Unauthorized");
  }
  await next();
};

function getUserById(db: Db, userId: string) {
  return db.select().from(users).where(eq(users.id, userId)).limit(1);
}

/** Users are created lazily on first sight (plan §4) — used by members and the dev fallback. */
export async function findOrCreateUser(db: Db, email: string, name: string | null) {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), email, name, createdAt: Date.now() })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (created) return created;
  // Lost a create race against a concurrent first request; the row exists by now.
  const [raced] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!raced) throw new Error(`user ${email} missing after create race`);
  return raced;
}
