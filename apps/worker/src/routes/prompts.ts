import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { extractVariables, projectPromptVariables, renderTemplate } from "../ai/prompts";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb, type Db } from "../db/client";
import { promptTemplates } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { parseBody, projectIdParams, savePromptSchema, validParams } from "./validation";

export const promptRoutes = new Hono<AppEnv>();

// Phase 4 stand-ins for the request-time variables; Phase 5 passes the real
// count from the generate request and the topic hint from the form. Phase 9:
// problem_context is request-scoped too (the selected problem). Phase 10: the
// outline/draft variables are request-scoped (the outlined idea, the section
// being written), so overrides referencing them resolve without an
// unknown-variable warning here.
const STAND_IN_VARS: Record<string, string> = {
  count: "5",
  topic_hint: "",
  problem_context: "",
  idea_title: "",
  idea_description: "",
  outline_markdown: "",
  section_heading: "",
  section_points: "",
  previous_sections: "",
  // Phase 11: the derivative prompts' draft variable is request-scoped (the
  // draft body the publish kit is generated from).
  draft_markdown: "",
};

// Garbage project ids 400 (ValidationError) before any DB lookup.
promptRoutes.use("/:projectId", validParams(projectIdParams));
promptRoutes.use("/:projectId/*", validParams(projectIdParams));

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
    ...projectPromptVariables(project),
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

  // Schema enforces the raw length cap and trim-checked non-emptiness; the
  // body is stored exactly as sent (never trimmed).
  const { body } = await parseBody(c, savePromptSchema);

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
      body,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [promptTemplates.projectId, promptTemplates.key],
      set: { name: defaultRow.name, body, updatedAt: now },
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
