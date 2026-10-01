/**
 * Authentication endpoints (plan §4/§7): register, login, logout, me.
 * All responses are JSON; password hashes never leave the database layer.
 * These routes sit behind the same resolveActor gate as the rest of the API —
 * register/login are on its public path list (they authenticate themselves),
 * me/logout require a valid session.
 */
import { eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { type AppEnv } from "../auth/actor";
import { hashPassword, verifyPassword } from "../auth/passwords";
import {
  createSession,
  destroySession,
  sessionClearCookie,
  sessionSetCookie,
  SESSION_COOKIE,
} from "../auth/sessions";
import { getDb } from "../db/client";
import { LOGIN_LIMIT, enforceRateLimit } from "../db/rateLimit";
import { users } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { parseBody } from "./validation";
import { z } from "zod";

export const authRoutes = new Hono<AppEnv>();

const MAX_EMAIL = 320;
const MAX_PASSWORD = 200;
const MAX_NAME = 200;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email({ message: "email must be a valid email address" })
      .max(MAX_EMAIL, `email must be at most ${MAX_EMAIL} characters`),
  );

const registerSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(MAX_PASSWORD, `password must be at most ${MAX_PASSWORD} characters`),
  name: z
    .string()
    .trim()
    .max(MAX_NAME, `name must be at most ${MAX_NAME} characters`)
    .optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "password must be a non-empty string"),
});

/** Public shape of a user row — never includes password_hash. */
function userJson(user: typeof users.$inferSelect) {
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * POST /register { email, password, name? } → 201 { user } + session cookie.
 * Registering an email that already has a password → 400 EmailTaken;
 * registering a passwordless (invited placeholder) email claims that account,
 * setting the hash and the name when one was provided (plan §4).
 */
authRoutes.post("/register", async (c) => {
  const { email, password, name } = await parseBody(c, registerSchema);
  const db = getDb(c.env);

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user: typeof users.$inferSelect;
  if (existing && existing.passwordHash) {
    throw new CodedHTTPException(
      400,
      "That email is already registered — try logging in.",
      "EmailTaken",
    );
  } else if (existing) {
    // Claim the invited placeholder account.
    const [claimed] = await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), ...(name ? { name } : {}) })
      .where(eq(users.id, existing.id))
      .returning();
    user = claimed;
  } else {
    const [created] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        name: name ?? null,
        passwordHash: await hashPassword(password),
        createdAt: Date.now(),
      })
      .returning();
    user = created;
  }

  const { token } = await createSession(db, user.id);
  c.header("Set-Cookie", sessionSetCookie(token));
  return c.json({ user: userJson(user) }, 201);
});

/**
 * POST /login { email, password } → 200 { user } + session cookie. Rate
 * limited per email BEFORE any lookup (10 attempts / 5 min). One generic
 * InvalidCredentials failure for unknown email, invited placeholder and wrong
 * password alike — never revealing whether the email exists.
 */
authRoutes.post("/login", async (c) => {
  const { email, password } = await parseBody(c, loginSchema);
  const db = getDb(c.env);

  await enforceRateLimit(db, `login:${email}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowMs);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw new CodedHTTPException(401, "Wrong email or password.", "InvalidCredentials");
  }

  const { token } = await createSession(db, user.id);
  c.header("Set-Cookie", sessionSetCookie(token));
  return c.json({ user: userJson(user) });
});

/** POST /logout — revoke the session (if any) and clear the cookie → 204. */
authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(getDb(c.env), token);
  c.header("Set-Cookie", sessionClearCookie());
  return c.body(null, 204);
});

/** GET /me — the signed-in account (actor gate guarantees a valid session). */
authRoutes.get("/me", async (c) => {
  const actor = c.get("actor");
  const [user] = await getDb(c.env).select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user) throw new CodedHTTPException(401, "Please sign in to continue.", "Unauthorized");
  return c.json(userJson(user));
});
