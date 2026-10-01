import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { effectiveModel } from "../ai/effective";
import { generateCompletion, OpenRouterError, httpStatusForError } from "../ai/openrouter";
import { apiKeyHint, decryptString, encryptString } from "../ai/secretbox";
import { TASKS } from "../ai/tasks";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb, type Db } from "../db/client";
import { projectAiConfig, projectModels } from "../db/schema";
import { CodedHTTPException } from "./errors";
import { readJsonObject } from "./helpers";

export const aiConfigRoutes = new Hono<AppEnv>();

const MAX_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 256;
const PROBE_MESSAGE = "Reply with the single word: pong";
const PROBE_MAX_TOKENS = 5;

type ConfigRow = typeof projectAiConfig.$inferSelect;

/**
 * Shared response shape for GET/PUT ai-config and PUT models. NEVER returns the
 * key or its ciphertext — only the hint, timestamps and model configuration.
 * Effective model per task = stored project_models row ?? registry default.
 */
async function configPayload(db: Db, projectId: string) {
  const [configRow]: (ConfigRow | undefined)[] = await db
    .select()
    .from(projectAiConfig)
    .where(eq(projectAiConfig.projectId, projectId))
    .limit(1);
  const modelRows = await db
    .select({ taskType: projectModels.taskType, model: projectModels.model })
    .from(projectModels)
    .where(eq(projectModels.projectId, projectId));
  const storedByTask = new Map(modelRows.map((m) => [m.taskType, m.model]));
  const configured = Boolean(configRow?.apiKeyEncrypted && configRow?.apiKeyHint);

  return {
    configured,
    api_key_hint: configured ? (configRow.apiKeyHint as string) : null,
    updated_at: configured ? new Date(configRow.updatedAt).toISOString() : null,
    models: modelRows.map((m) => ({ task_type: m.taskType, model: m.model })),
    tasks: TASKS.map((t) => {
      const stored = storedByTask.get(t.key);
      return {
        key: t.key,
        label: t.label,
        prompt_key: t.promptKey,
        default_model: t.defaultModel,
        model: stored ?? t.defaultModel,
        is_default: stored === undefined,
      };
    }),
  };
}

/** GET /api/projects/:id/ai-config — member read. */
aiConfigRoutes.get("/:projectId/ai-config", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  return c.json(await configPayload(getDb(c.env), project.id));
});

/** PUT /api/projects/:id/ai-config `{ api_key }` — editor+. Encrypts + upserts. */
aiConfigRoutes.put("/:projectId/ai-config", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const body = await readJsonObject(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!apiKey) return c.json({ error: "api_key must be a non-empty string" }, 400);
  if (apiKey.length > MAX_KEY_LENGTH) {
    return c.json({ error: `api_key must be at most ${MAX_KEY_LENGTH} characters` }, 400);
  }

  const encrypted = await encryptString(apiKey, c.env.ENCRYPTION_KEY);
  const now = Date.now();
  await getDb(c.env)
    .insert(projectAiConfig)
    .values({
      projectId: project.id,
      apiKeyEncrypted: encrypted,
      apiKeyHint: apiKeyHint(apiKey),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectAiConfig.projectId,
      set: { apiKeyEncrypted: encrypted, apiKeyHint: apiKeyHint(apiKey), updatedAt: now },
    });
  return c.json(await configPayload(getDb(c.env), project.id));
});

/** PUT /api/projects/:id/models `{ models: [{ task_type, model }] }` — editor+. */
aiConfigRoutes.put("/:projectId/models", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const body = await readJsonObject(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  if (!Array.isArray(body.models)) {
    return c.json({ error: "models must be an array of { task_type, model }" }, 400);
  }

  const taskKeys = TASKS.map((t) => t.key);
  const seen = new Set<string>();
  const rows: { taskType: string; model: string }[] = [];
  for (const entry of body.models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return c.json({ error: "Each models entry must be an object with task_type and model" }, 400);
    }
    const { task_type, model } = entry as { task_type?: unknown; model?: unknown };
    if (typeof task_type !== "string" || !TASKS.some((t) => t.key === task_type)) {
      return c.json({ error: `task_type must be one of: ${taskKeys.join(", ")}` }, 400);
    }
    if (typeof model !== "string" || !model.trim()) {
      return c.json({ error: `model for task "${task_type}" must be a non-empty string` }, 400);
    }
    if (model.trim().length > MAX_MODEL_LENGTH) {
      return c.json(
        { error: `model for task "${task_type}" must be at most ${MAX_MODEL_LENGTH} characters` },
        400,
      );
    }
    if (seen.has(task_type)) return c.json({ error: `Duplicate task_type "${task_type}"` }, 400);
    seen.add(task_type);
    rows.push({ taskType: task_type, model: model.trim() });
  }

  const db = getDb(c.env);
  if (rows.length > 0) {
    // One atomic batch; the UNIQUE(project_id, task_type) index turns repeats
    // into updates. rows is non-empty here; batch requires a non-empty tuple.
    const statements = rows.map((row) =>
      db
        .insert(projectModels)
        .values({ projectId: project.id, taskType: row.taskType, model: row.model })
        .onConflictDoUpdate({
          target: [projectModels.projectId, projectModels.taskType],
          set: { model: row.model },
        }),
    ) as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
    await db.batch(statements);
  }
  return c.json(await configPayload(db, project.id));
});

/**
 * POST /api/projects/:id/ai-config/test — editor+. Cheap live probe through the
 * saved (decrypted) key; optional `{ model }` override, default is the
 * effective model for idea_generation. Never stores anything: failures are
 * mapped to the typed error taxonomy with proper HTTP statuses and the
 * `{ error, code }` envelope.
 */
aiConfigRoutes.post("/:projectId/ai-config/test", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  // Body is optional; a missing/empty body means "use the saved configuration".
  const body = (await readJsonObject(c)) ?? {};

  let modelOverride: string | undefined;
  if ("model" in body) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return c.json({ error: "model must be a non-empty string when provided" }, 400);
    }
    modelOverride = body.model.trim();
    if (modelOverride.length > MAX_MODEL_LENGTH) {
      return c.json({ error: `model must be at most ${MAX_MODEL_LENGTH} characters` }, 400);
    }
  }

  const db = getDb(c.env);
  const [configRow]: (ConfigRow | undefined)[] = await db
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

  let model = modelOverride;
  if (!model) {
    // One source of truth for stored-row-??-registry-default (see ai/effective.ts).
    model = await effectiveModel(db, project.id, "idea_generation");
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

  const startedAt = Date.now();
  try {
    const sample = await generateCompletion({
      apiKey,
      model,
      messages: [{ role: "user", content: PROBE_MESSAGE }],
      maxTokens: PROBE_MAX_TOKENS,
    });
    return c.json({ ok: true, model, latency_ms: Date.now() - startedAt, sample });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      return c.json({ error: err.message, code: err.code }, httpStatusForError(err));
    }
    throw err;
  }
});
