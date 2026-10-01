import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { users } from "../db/schema";

export type ProjectRole = "owner" | "editor";

export type Actor = {
  userId: string;
  email: string;
  /** Role in the project a request targets; routes read it from requireProject. */
  projectRole: ProjectRole | null;
};

/** Hono env used across the API: worker bindings + request-scoped actor. */
export type AppEnv = { Bindings: Env; Variables: { actor: Actor } };

const DEFAULT_DEV_EMAIL = "dev@postgavel.local";

/**
 * DEV STUB ONLY: identity comes from the X-Dev-User header (an email address),
 * falling back to a fixed dev account. Real auth (JWT/OIDC/session cookie)
 * later replaces only the resolution below - Actor, routes and authorization
 * stay unchanged. No route may trust client-supplied user ids.
 */
export const resolveActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = (c.req.header("X-Dev-User") ?? "").trim().toLowerCase() || DEFAULT_DEV_EMAIL;
  const user = await findOrCreateUser(getDb(c.env), email, email === DEFAULT_DEV_EMAIL ? "Dev User" : null);
  c.set("actor", { userId: user.id, email: user.email, projectRole: null });
  await next();
};

/** Users are created lazily on first sight (plan §4); login will upsert later. */
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
