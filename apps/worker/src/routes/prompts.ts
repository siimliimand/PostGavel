import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { extractVariables, renderTemplate } from "../ai/prompts";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb, type Db } from "../db/client";
import { promptTemplates } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { readJsonObject } from "./helpers";

export const promptRoutes = new Hono<AppEnv>();

const MAX_BODY_LENGTH = 20_000;
// Phase 4 stand-ins for the request-time variables; Phase 5 passes the real
// count from the generate request and the topic hint from the form.
const STAND_IN_VARS: Record<string, string> = { count: "5", topic_hint: "" };

type PromptRow = typeof promptTemplates.$inferSelect;

/**
 * One prompt in list/single responses: the immutable global default next to
 * the project's override (if any) plus the effective body. API shape is
 * snake_case, matching plan §3 column names.
 */
function promptJson(defaultRow: PromptRow, overrideRow: PromptRow | undefined) {
  return {
    key: defaultRow.key,
    name: defaultRow.name,
    // Documented from the default body: an override should keep the same
    // variables, and unknown ones surface via the resolved endpoint instead.
    variables: extractVariables(defaultRow.body),
    default_body: defaultRow.body,
    override_body: overrideRow?.body ?? null,
    body: overrideRow?.body ?? defaultRow.body,
    is_override: overrideRow !== undefined,
  };
}

/**
 * Shared response shape for the prompts list and PUT responses: the universe
 * of prompt keys is the set of global default rows (project_id IS NULL), in
 * seeded order (created_at, key as deterministic tiebreak — the seed gives
 * every default the same timestamp). Overrides never add keys; a stray
 * override without a default (impossible via the API) is ignored.
 */
async function promptsPayload(db: Db, projectId: string) {
  const defaults = await db
    .select()
    .from(promptTemplates)
    .where(isNull(promptTemplates.projectId))
    .orderBy(asc(promptTemplates.createdAt), asc(promptTemplates.key));
  const overrideRows = await db
    .select()
    .from(promptTemplates)
    .where(eq(promptTemplates.projectId, projectId));
  const overrideByKey = new Map(overrideRows.map((row) => [row.key, row]));
  return defaults.map((defaultRow) => promptJson(defaultRow, overrideByKey.get(defaultRow.key)));
}

/** GET /api/projects/:id/prompts — member read. */
promptRoutes.get("/:projectId/prompts", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  return c.json(await promptsPayload(getDb(c.env), project.id));
});

// Registered before /:key so "resolved" is not captured as a prompt key.
/** GET /api/projects/:id/prompts/resolved — member read. Effective prompts with {{variables}} substituted from the project brief. */
promptRoutes.get("/:projectId/prompts/resolved", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const prompts = await promptsPayload(getDb(c.env), project.id);
  const vars: Record<string, string> = {
    project_description: project.description ?? "",
    content_guidelines: project.contentGuidelines ?? "",
    content_types: project.contentTypes ?? "",
    ...STAND_IN_VARS,
  };
  return c.json(
    prompts.map(({ key, name, body }) => {
      const { text, unknown } = renderTemplate(body, vars);
      return {
        key,
        name,
        text,
        warnings: unknown.map((variable) => `Unknown variable {{${variable}}} left unresolved`),
      };
    }),
  );
});

/** PUT /api/projects/:id/prompts/:key `{ body }` — editor+. Upserts the override. */
promptRoutes.put("/:projectId/prompts/:key", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const key = c.req.param("key");

  const payload = await readJsonObject(c);
  if (!payload) return c.json({ error: "Invalid JSON body" }, 400);
  if (typeof payload.body !== "string") return c.json({ error: "body must be a string" }, 400);
  if (!payload.body.trim()) return c.json({ error: "body must be a non-empty string" }, 400);
  if (payload.body.length > MAX_BODY_LENGTH) {
    return c.json({ error: `body must be at most ${MAX_BODY_LENGTH} characters` }, 400);
  }

  const db = getDb(c.env);
  // The universe of prompt keys is the global defaults; overriding an unknown
  // key is a client error, not a 404 (the project itself exists).
  const [defaultRow] = await db
    .select()
    .from(promptTemplates)
    .where(and(isNull(promptTemplates.projectId), eq(promptTemplates.key, key)))
    .limit(1);
  if (!defaultRow) {
    return c.json({ error: `Unknown prompt key "${key}" (not a global default)` }, 400);
  }

  const now = Date.now();
  const [overrideRow] = await db
    .insert(promptTemplates)
    .values({
      id: crypto.randomUUID(),
      projectId: project.id,
      key,
      // Copied from the global row at override time; the default stays
      // authoritative for variables/ordering.
      name: defaultRow.name,
      body: payload.body,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [promptTemplates.projectId, promptTemplates.key],
      set: { name: defaultRow.name, body: payload.body, updatedAt: now },
    })
    .returning();
  return c.json(promptJson(defaultRow, overrideRow));
});

/** DELETE /api/projects/:id/prompts/:key — editor+. Removes the override. */
promptRoutes.delete("/:projectId/prompts/:key", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const removed = await getDb(c.env)
    .delete(promptTemplates)
    .where(
      and(eq(promptTemplates.projectId, project.id), eq(promptTemplates.key, c.req.param("key"))),
    )
    .returning();
  if (removed.length === 0) {
    // Already default: there is no override row to remove.
    throw new CodedHTTPException(
      404,
      "No override to reset — this prompt already uses the global default",
      "NoOverride",
    );
  }
  return c.body(null, 204);
});
