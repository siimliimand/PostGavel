import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { problemContext } from "../ai/prompts";
import { GENERATION_TASKS, runGeneration } from "../tasks/registry";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb } from "../db/client";
import { articleIdeas, problems } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { generateIdeasSchema, ideaParams, parseBody, projectIdParams, validParams } from "./validation";

export const ideaRoutes = new Hono<AppEnv>();

const LIST_LIMIT = 200;

// Garbage project ids 400 (ValidationError) before any DB lookup. (:ideaId is
// validated inline on DELETE only — a `use("/…/ideas/:ideaId")` middleware
// would also capture the literal "generate" segment.)
ideaRoutes.use("/:projectId", validParams(projectIdParams));
ideaRoutes.use("/:projectId/*", validParams(projectIdParams));

function ideaJson(row: typeof articleIdeas.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    angle: row.angle,
    problem_id: row.problemId,
    created_at: new Date(row.createdAt).toISOString(),
    created_by: row.createdBy,
  };
}

/**
 * POST /api/projects/:id/ideas/generate `{ topic_hint?, count?, problem_id? }`
 * — editor+ (it spends credits). Delegates to the shared generation pipeline
 * (registry task `article_ideas`). With `problem_id`, the ideas are scoped to
 * that audience problem via the `{{problem_context}}` variable and stored with
 * the link; without it, unscoped generation as before. Provider failures
 * surface as the typed error taxonomy via the shared status map; nothing
 * sensitive is ever echoed back.
 */
ideaRoutes.post("/:projectId/ideas/generate", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const actor = c.get("actor");
  const {
    topic_hint: topicHint = "",
    count,
    problem_id: problemId,
  } = await parseBody(c, generateIdeasSchema);

  // Scope validation: the problem must exist AND belong to this project.
  let problem: typeof problems.$inferSelect | undefined;
  if (problemId) {
    [problem] = await getDb(c.env)
      .select()
      .from(problems)
      .where(and(eq(problems.id, problemId), eq(problems.projectId, project.id)))
      .limit(1);
    if (!problem) {
      throw new CodedHTTPException(
        400,
        "problem_id does not belong to this project",
        "ValidationError",
      );
    }
  }

  const result = await runGeneration(c.env, project, actor.userId, GENERATION_TASKS.article_ideas, {
    count,
    vars: { topic_hint: topicHint, problem_context: problem ? problemContext(problem) : "" },
    extra: { problemId: problem?.id ?? null },
  });

  return c.json(
    {
      ideas: result.rows.map((row) => ideaJson(row)),
      model: result.model,
      used_retry: result.usedRetry,
      ...(problem ? { problem_id: problem.id } : {}),
      ...(result.warnings.length > 0 ? { prompt_warnings: result.warnings } : {}),
    },
    201,
  );
});

/** GET /api/projects/:id/ideas — member read, newest first, capped at 200. */
ideaRoutes.get("/:projectId/ideas", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const rows = await getDb(c.env)
    .select()
    .from(articleIdeas)
    .where(eq(articleIdeas.projectId, project.id))
    .orderBy(desc(articleIdeas.createdAt), desc(articleIdeas.id))
    .limit(LIST_LIMIT);
  return c.json(rows.map(ideaJson));
});

/** DELETE /api/projects/:id/ideas/:ideaId — editor+, scoped to the project. */
ideaRoutes.delete(
  "/:projectId/ideas/:ideaId",
  validParams(ideaParams),
  async (c) => {
    const { project } = await requireProject(c, c.req.param("projectId"));
    const removed = await getDb(c.env)
      .delete(articleIdeas)
      .where(
        and(eq(articleIdeas.projectId, project.id), eq(articleIdeas.id, c.req.param("ideaId"))),
      )
      .returning();
    if (removed.length === 0) throw new HTTPException(404, { message: "Idea not found" });
    return c.body(null, 204);
  },
);
