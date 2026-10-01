import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { effectiveModel } from "../ai/effective";
import { parseIdeasJson, STRICT_RETRY_SUFFIX } from "../ai/ideas";
import { generateCompletion, httpStatusForError, OpenRouterError } from "../ai/openrouter";
import { renderTemplate } from "../ai/prompts";
import { decryptString } from "../ai/secretbox";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { enforceRateLimit, IDEAS_GENERATE_LIMIT } from "../db/rateLimit";
import { getDb, type Db } from "../db/client";
import { articleIdeas, projectAiConfig, promptTemplates } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { generateIdeasSchema, ideaParams, parseBody, projectIdParams, validParams } from "./validation";

export const ideaRoutes = new Hono<AppEnv>();

const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 10;
// Completion budget scales with the requested count: a fixed ceiling truncates
// high-count replies mid-JSON, which is a guaranteed parse failure. Capped so
// a maxed-out count cannot produce an oversized provider request.
const GENERATE_MAX_TOKENS_BASE = 400;
const GENERATE_MAX_TOKENS_PER_IDEA = 600;
const GENERATE_MAX_TOKENS_CAP = 8000;
const LIST_LIMIT = 200;
const SYSTEM_PROMPT_KEY = "system";
const IDEAS_PROMPT_KEY = "article_ideas";

// Garbage project ids 400 (ValidationError) before any DB lookup. (:ideaId is
// validated inline on DELETE only — a `use("/…/ideas/:ideaId")` middleware
// would also capture the literal "generate" segment.)
ideaRoutes.use("/:projectId", validParams(projectIdParams));
ideaRoutes.use("/:projectId/*", validParams(projectIdParams));

/** Effective prompt body for a key: the project's override ?? the global default. */
async function resolvePromptBody(db: Db, projectId: string, key: string): Promise<string> {
  const [defaultRow] = await db
    .select()
    .from(promptTemplates)
    .where(and(isNull(promptTemplates.projectId), eq(promptTemplates.key, key)))
    .limit(1);
  // Invariant: every key used here is seeded as a global default (migration 0003).
  if (!defaultRow) throw new Error(`global default prompt "${key}" is missing`);
  const [overrideRow] = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.projectId, projectId), eq(promptTemplates.key, key)))
    .limit(1);
  return overrideRow?.body ?? defaultRow.body;
}

/** Token ceiling for one generation call at the given idea count. */
function generateMaxTokens(count: number): number {
  return Math.min(
    GENERATE_MAX_TOKENS_CAP,
    GENERATE_MAX_TOKENS_BASE + GENERATE_MAX_TOKENS_PER_IDEA * count,
  );
}

function ideaJson(row: typeof articleIdeas.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    angle: row.angle,
    created_at: new Date(row.createdAt).toISOString(),
    created_by: row.createdBy,
  };
}

/**
 * POST /api/projects/:id/ideas/generate `{ topic_hint?, count? }` — editor+
 * (it spends credits). Resolves key + model + prompts (plan §5), calls
 * OpenRouter, parses/validates the JSON reply (one stricter retry), stores the
 * ideas and returns them. Provider failures surface as the typed error
 * taxonomy via the shared status map; nothing sensitive is ever echoed back.
 */
ideaRoutes.post("/:projectId/ideas/generate", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const actor = c.get("actor");
  // Body is optional; count is clamped (rounded, 1..10) not rejected — only a
  // non-numeric count is a validation error.
  const { topic_hint: topicHint = "", count: requestedCount } = await parseBody(c, generateIdeasSchema);

  // Cheap rejection BEFORE any config read / key decrypt / provider call.
  await enforceRateLimit(
    getDb(c.env),
    project.id,
    IDEAS_GENERATE_LIMIT.action,
    IDEAS_GENERATE_LIMIT.limit,
    IDEAS_GENERATE_LIMIT.windowMs,
  );

  const count = Math.min(
    MAX_COUNT,
    Math.max(MIN_COUNT, Math.round(requestedCount ?? DEFAULT_COUNT)),
  );

  const db = getDb(c.env);
  const [configRow] = await db
    .select()
    .from(projectAiConfig)
    .where(eq(projectAiConfig.projectId, project.id))
    .limit(1);
  if (!configRow?.apiKeyEncrypted) {
    throw new CodedHTTPException(
      400,
      "No OpenRouter API key is configured for this project. Save a key first.",
      "NotConfigured",
    );
  }

  let apiKey: string;
  try {
    apiKey = await decryptString(configRow.apiKeyEncrypted, c.env.ENCRYPTION_KEY);
  } catch {
    // Corrupt blob or the ENCRYPTION_KEY secret changed after the key was
    // stored. Never surface decrypted material — there is none anyway.
    throw new CodedHTTPException(
      500,
      "The stored API key could not be decrypted (was the ENCRYPTION_KEY secret changed?). Save the key again.",
      "DecryptFailed",
    );
  }

  // Model + prompt resolution happens BEFORE the provider call, so a broken
  // model/prompt setup can never crash or bypass the typed provider errors.
  const model = await effectiveModel(db, project.id, "idea_generation");
  const [systemBody, ideasBody] = await Promise.all([
    resolvePromptBody(db, project.id, SYSTEM_PROMPT_KEY),
    resolvePromptBody(db, project.id, IDEAS_PROMPT_KEY),
  ]);
  const vars: Record<string, string> = {
    project_description: project.description ?? "",
    content_guidelines: project.contentGuidelines ?? "",
    content_types: project.contentTypes ?? "",
    count: String(count),
    topic_hint: topicHint,
  };
  const system = renderTemplate(systemBody, vars);
  const user = renderTemplate(ideasBody, vars);
  // Informational: unresolved {{variables}} surface as warnings, never a failure.
  const promptWarnings = [...new Set([...system.unknown, ...user.unknown])].map(
    (variable) => `Unknown variable {{${variable}}} left unresolved`,
  );

  const callModel = async (userText: string): Promise<string> => {
    try {
      return await generateCompletion({
        apiKey,
        model,
        messages: [
          { role: "system", content: system.text },
          { role: "user", content: userText },
        ],
        json: true,
        maxTokens: generateMaxTokens(count),
      });
    } catch (err) {
      if (err instanceof OpenRouterError) {
        throw new CodedHTTPException(httpStatusForError(err), err.message, err.code);
      }
      throw err as Error;
    }
  };

  const content = await callModel(user.text);

  let parsed = parseIdeasJson(content, count);
  let usedRetry = false;
  if (parsed.problem) {
    // One retry with a stricter instruction, per plan §5. The raw reply is
    // logged (truncated) on the first failure only, to make parse drift
    // diagnosable — replies are model output, never secret material.
    console.error("[ideas] unparsable model reply:", content.slice(0, 600));
    usedRetry = true;
    const retryContent = await callModel(`${user.text}\n\n${STRICT_RETRY_SUFFIX}`);
    parsed = parseIdeasJson(retryContent, count);
    if (parsed.problem) {
      throw new CodedHTTPException(
        502,
        "The AI's reply could not be parsed into article ideas, even after one stricter retry. Please try generating again.",
        "GenerationFailed",
      );
    }
  }

  // One atomic multi-row INSERT: all ideas land or none do.
  const now = Date.now();
  const rows = parsed.ideas.map((idea) => ({
    id: crypto.randomUUID(),
    projectId: project.id,
    title: idea.title,
    angle: idea.angle,
    createdAt: now,
    createdBy: actor.userId,
  }));
  await db.insert(articleIdeas).values(rows);

  return c.json(
    {
      ideas: rows.map((row) => ideaJson(row)),
      model,
      used_retry: usedRetry,
      ...(promptWarnings.length > 0 ? { prompt_warnings: promptWarnings } : {}),
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
