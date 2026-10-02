import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { GENERATION_TASKS, runGeneration } from "../tasks/registry";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb } from "../db/client";
import { problems } from "../db/schema";
import {
  createProblemSchema,
  generateProblemsSchema,
  parseBody,
  problemParams,
  projectIdParams,
  validParams,
} from "./validation";

export const problemRoutes = new Hono<AppEnv>();

const LIST_LIMIT = 200;

// Garbage project ids 400 (ValidationError) before any DB lookup. (:problemId
// is validated inline on DELETE only — a `use("/…/problems/:problemId")`
// middleware would also capture the literal "generate" segment.)
problemRoutes.use("/:projectId", validParams(projectIdParams));
problemRoutes.use("/:projectId/*", validParams(projectIdParams));

/** API shape is snake_case, matching the column names in plan §3. */
function problemJson(row: typeof problems.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    search_signals: row.searchSignals,
    source: row.source,
    created_at: new Date(row.createdAt).toISOString(),
  };
}

/** GET /api/projects/:id/problems — member read, newest first. */
problemRoutes.get("/:projectId/problems", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const rows = await getDb(c.env)
    .select()
    .from(problems)
    .where(eq(problems.projectId, project.id))
    .orderBy(desc(problems.createdAt), desc(problems.id))
    .limit(LIST_LIMIT);
  return c.json(rows.map(problemJson));
});

/**
 * POST /api/projects/:id/problems `{ title, description?, search_signals? }` —
 * editor+. Manual add: stored with source='manual', appends to the list.
 */
problemRoutes.post("/:projectId/problems", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const { title, description, search_signals: searchSignals } = await parseBody(
    c,
    createProblemSchema,
  );

  const row: typeof problems.$inferSelect = {
    id: crypto.randomUUID(),
    projectId: project.id,
    title,
    description: description ? description : null,
    searchSignals: searchSignals ? searchSignals : null,
    source: "manual",
    createdAt: Date.now(),
  };
  await getDb(c.env).insert(problems).values(row);
  return c.json(problemJson(row), 201);
});

/**
 * POST /api/projects/:id/problems/generate `{ count? }` (1..10, default 5) —
 * editor+ (it spends credits). AI-generates audience problems through the
 * shared generation pipeline (registry task `audience_problems`), appends them
 * with source='ai' and returns the created rows.
 */
problemRoutes.post("/:projectId/problems/generate", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const actor = c.get("actor");
  const { count } = await parseBody(c, generateProblemsSchema);

  const result = await runGeneration(
    c.env,
    project,
    actor.userId,
    GENERATION_TASKS.audience_problems,
    { count },
  );

  return c.json(
    {
      problems: result.rows.map(problemJson),
      model: result.model,
      used_retry: result.usedRetry,
      ...(result.warnings.length > 0 ? { prompt_warnings: result.warnings } : {}),
    },
    201,
  );
});

/** DELETE /api/projects/:id/problems/:problemId — editor+, scoped to the project. */
problemRoutes.delete(
  "/:projectId/problems/:problemId",
  validParams(problemParams),
  async (c) => {
    const { project } = await requireProject(c, c.req.param("projectId"));
    const removed = await getDb(c.env)
      .delete(problems)
      .where(
        and(eq(problems.projectId, project.id), eq(problems.id, c.req.param("problemId"))),
      )
      .returning();
    if (removed.length === 0) throw new HTTPException(404, { message: "Problem not found" });
    return c.body(null, 204);
  },
);
