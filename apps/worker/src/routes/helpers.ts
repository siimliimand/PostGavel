import type { Context } from "hono";
import type { AppEnv } from "../auth/actor";

/**
 * Parse a JSON object body. Returns null for missing/invalid/non-object bodies
 * so handlers can answer 400. (Phase 6 replaces this with zod.)
 */
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}
