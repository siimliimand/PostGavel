/**
 * Session management (plan §4): login/register mint a 256-bit random token,
 * store only its hex SHA-256 in D1 (a database leak must not yield usable
 * sessions) and set it as an HttpOnly cookie. Expiry slides: a session used in
 * the second half of its life is extended back to the full TTL, so active
 * users stay signed in while abandoned sessions die after 30 days.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";

export const SESSION_COOKIE = "pg_session";

/** 30 days, in milliseconds (timestamps are unix ms per schema conventions). */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const encoder = new TextEncoder();

export type CreatedSession = { token: string; expiresAt: number };

export type ResolvedSession = {
  session: typeof sessions.$inferSelect;
  userId: string;
};

function sha256Hex(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

/** URL-safe token: base64url of 32 random bytes (no `+ / =` cookie pitfalls). */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(db: Db, userId: string): Promise<CreatedSession> {
  const token = mintToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt,
    lastUsedAt: now,
  });
  return { token, expiresAt };
}

/**
 * Resolve a raw token to its session row. Missing/expired → null (expired rows
 * are deleted lazily). Sliding renewal: past half-life, the expiry is pushed
 * back to a full TTL from now.
 */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | null> {
  const id = await sha256Hex(token);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (now - session.createdAt > SESSION_TTL_MS / 2) {
    const expiresAt = now + SESSION_TTL_MS;
    await db
      .update(sessions)
      .set({ expiresAt, lastUsedAt: now })
      .where(eq(sessions.id, id));
  }
  return { session, userId: session.userId };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}

// --- Cookie helpers -------------------------------------------------------
// `Secure` is fine on http://localhost: wrangler dev is treated as a secure
// context, so Chromium and curl both store/send the cookie (curl needs -k only
// for https; on plain http it ignores Secure for localhost).

export function sessionSetCookie(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Clearing variant: instructs the browser to drop the cookie immediately. */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
