/**
 * Generation task registry (Phase 9). One place mapping a generation task to
 * its prompt key, model task, count bounds, rate limit, parser and persistence
 * — and one shared `runGeneration` used by EVERY generate route, so provider
 * calling, typed error mapping, prompt resolution and the one strict retry
 * cannot drift between tasks (plan §5).
 *
 * Adding a future generation task: a registry entry here plus — if it needs
 * its own model picker — one entry in src/ai/tasks.ts. Since Phase 10 this is
 * six tasks: ideas, problems, two outline variants (single JSON call) and two
 * draft variants (run per outline section, see the draft entries below).
 */
import { and, eq, isNull } from "drizzle-orm";
import { effectiveModel } from "../ai/effective";
import { renderTemplate, projectPromptVariables } from "../ai/prompts";
import { generateCompletion, httpStatusForError, OpenRouterError } from "../ai/openrouter";
import { decryptString } from "../ai/secretbox";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { enforceRateLimit } from "../db/rateLimit";
import { articleIdeas, problems, projectAiConfig, promptTemplates, type projects } from "../db/schema";
import { CodedHTTPException } from "../routes/errors";
import type { WorkerEnv } from "../env";
import {
  parseIdeasJson,
  STRICT_RETRY_SUFFIX as IDEAS_RETRY_SUFFIX,
  type ParsedIdea,
} from "../ai/ideas";
import {
  parseOutlineJson,
  outlineToMarkdown,
  STRICT_RETRY_SUFFIX as OUTLINE_RETRY_SUFFIX,
  type ParsedOutline,
} from "../ai/outline";
import { pieces } from "../db/schema";
import {
  parseProblemsJson,
  STRICT_RETRY_SUFFIX as PROBLEMS_RETRY_SUFFIX,
  type ParsedProblem,
} from "../ai/problems";

export type ProjectRow = typeof projects.$inferSelect;

export type PersistContext = {
  project: ProjectRow;
  actorUserId: string;
  /** The resolved model — stored on generated rows for provenance. */
  model: string;
  /** Task-specific extras passed through from the route (e.g. problem_id). */
  extra: Record<string, unknown>;
};

/**
 * One registry entry. `parse` never throws — zero usable items come back as a
 * `problem` string that triggers the single stricter retry.
 */
export type GenerationTask<TItem, TRow> = {
  /** Registry key (ai/tasks key of the route's model-per-task entry). */
  key: string;
  /** prompt_templates key resolved (project override ?? global default). */
  promptKey: string;
  /** project_models task_type used for model resolution. */
  modelTask: string;
  defaultCount: number;
  maxCount: number;
  /** Fixed-window limit keyed per project ("<projectId>:<action>"). */
  rateLimit: { action: string; limit: number; windowMs: number };
  strictRetrySuffix: string;
  /** 502 GenerationFailed message when even the retry cannot be parsed. */
  parseFailureMessage: string;
  /** Request `response_format: json_object`; drafts write raw markdown. */
  jsonMode: boolean;
  /** Fixed completion budget when the count-derived one is the wrong shape
   * (one outline/section has a known output size, count is meaningless). */
  maxTokens?: number;
  parse(content: string, count: number): { items: TItem[]; problem?: string };
  /** One atomic multi-row INSERT: all rows land or none do. */
  persist(db: Db, ctx: PersistContext, items: TItem[]): Promise<TRow[]>;
};

export type RunGenerationParams = {
  /** Pre-validated count; falls back to the task default when absent. */
  count?: number;
  /** Request-scoped prompt variables layered on the brief (topic_hint, …). */
  vars?: Record<string, string>;
  /** Passed through to persist() (e.g. the scoped problem_id). */
  extra?: Record<string, unknown>;
  /** Skip the final persist — the per-section draft loop stores ONE combined
   * row after the last section instead. Rows then come back []. */
  skipPersist?: boolean;
};

export type GenerationResult<TItem, TRow> = {
  rows: TRow[];
  /** The parsed task items (the section texts for a per-section draft call). */
  items: TItem[];
  model: string;
  /** True when the reply only parsed after the one stricter retry. */
  usedRetry: boolean;
  /** Informational unknown-{{variable}} warnings, never a failure. */
  warnings: string[];
};

// Completion budget scales with the requested count: a fixed ceiling truncates
// high-count replies mid-JSON, which is a guaranteed parse failure. Capped so
// a maxed-out count cannot produce an oversized provider request.
const GENERATE_MAX_TOKENS_BASE = 400;
const GENERATE_MAX_TOKENS_PER_ITEM = 600;
const GENERATE_MAX_TOKENS_CAP = 8000;

/** Token ceiling for one generation call at the given item count. */
function generateMaxTokens(count: number): number {
  return Math.min(
    GENERATE_MAX_TOKENS_CAP,
    GENERATE_MAX_TOKENS_BASE + GENERATE_MAX_TOKENS_PER_ITEM * count,
  );
}

const SYSTEM_PROMPT_KEY = "system";

/** Effective prompt body for a key: the project's override ?? the global default. */
async function resolvePromptBody(db: Db, projectId: string, key: string): Promise<string> {
  const [defaultRow] = await db
    .select()
    .from(promptTemplates)
    .where(and(isNull(promptTemplates.projectId), eq(promptTemplates.key, key)))
    .limit(1);
  // Invariant: every key used here is seeded as a global default (migrations 0003/0009).
  if (!defaultRow) throw new Error(`global default prompt "${key}" is missing`);
  const [overrideRow] = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.projectId, projectId), eq(promptTemplates.key, key)))
    .limit(1);
  return overrideRow?.body ?? defaultRow.body;
}

/** The route registry — generation task key → everything a route needs. */
export const GENERATION_TASKS: {
  article_ideas: GenerationTask<ParsedIdea, typeof articleIdeas.$inferSelect>;
  audience_problems: GenerationTask<ParsedProblem, typeof problems.$inferSelect>;
  article_outline: GenerationTask<ParsedOutline, typeof pieces.$inferSelect>;
  video_outline: GenerationTask<ParsedOutline, typeof pieces.$inferSelect>;
  article_draft: GenerationTask<string, typeof pieces.$inferSelect>;
  video_script: GenerationTask<string, typeof pieces.$inferSelect>;
} = {
  article_ideas: {
    key: "idea_generation",
    promptKey: "article_ideas",
    modelTask: "idea_generation",
    defaultCount: 5,
    maxCount: 10,
    rateLimit: { action: "ideas_generate", limit: 5, windowMs: 60_000 },
    strictRetrySuffix: IDEAS_RETRY_SUFFIX,
    parseFailureMessage:
      "The AI's reply could not be parsed into article ideas, even after one stricter retry. Please try generating again.",
    jsonMode: true,
    parse: (content: string, count: number) => {
      const { ideas, problem } = parseIdeasJson(content, count);
      return { items: ideas, problem };
    },
    persist: async (db: Db, ctx: PersistContext, items: { title: string; angle: string }[]) => {
      const now = Date.now();
      const rows = items.map((idea) => ({
        id: crypto.randomUUID(),
        projectId: ctx.project.id,
        title: idea.title,
        angle: idea.angle,
        problemId: (ctx.extra.problemId as string | null | undefined) ?? null,
        createdAt: now,
        createdBy: ctx.actorUserId,
      }));
      await db.insert(articleIdeas).values(rows);
      return rows;
    },
  },
  audience_problems: {
    key: "problem_generation",
    promptKey: "audience_problems",
    modelTask: "problem_generation",
    defaultCount: 5,
    maxCount: 10,
    rateLimit: { action: "problems_generate", limit: 5, windowMs: 60_000 },
    strictRetrySuffix: PROBLEMS_RETRY_SUFFIX,
    parseFailureMessage:
      "The AI's reply could not be parsed into problems, even after one stricter retry. Please try generating again.",
    jsonMode: true,
    parse: (content: string, count: number) => {
      const { problems: parsed, problem } = parseProblemsJson(content, count);
      return { items: parsed, problem };
    },
    persist: async (
      db: Db,
      ctx: PersistContext,
      items: { title: string; description?: string; search_signals?: string }[],
    ) => {
      const now = Date.now();
      const rows = items.map((problem) => ({
        id: crypto.randomUUID(),
        projectId: ctx.project.id,
        title: problem.title,
        description: problem.description ?? null,
        searchSignals: problem.search_signals ?? null,
        source: "ai",
        createdAt: now,
      }));
      await db.insert(problems).values(rows);
      return rows;
    },
  },
  // Phase 10 — outlines. One call, one row: the reply is the JSON outline,
  // the stored body is its markdown render and `sections` keeps the parsed
  // structure for the Content page (and the draft loop).
  article_outline: {
    key: "article_outline",
    promptKey: "article_outline",
    modelTask: "article_outline",
    defaultCount: 1,
    maxCount: 1,
    rateLimit: { action: "pieces_outline", limit: 5, windowMs: 60_000 },
    strictRetrySuffix: OUTLINE_RETRY_SUFFIX,
    parseFailureMessage:
      "The AI's reply could not be parsed into an outline, even after one stricter retry. Please try again.",
    jsonMode: true,
    // One outline JSON (up to 9 sections x 4 points) needs more room than the
    // count-derived budget for count=1.
    maxTokens: 3000,
    parse: (content: string) => {
      const { outline, problem } = parseOutlineJson(content);
      return outline ? { items: [outline] } : { items: [], problem };
    },
    persist: async (db: Db, ctx: PersistContext, items: ParsedOutline[]) => {
      const outline = items[0];
      const row: typeof pieces.$inferSelect = {
        id: crypto.randomUUID(),
        projectId: ctx.project.id,
        problemId: (ctx.extra.problemId as string | null | undefined) ?? null,
        ideaId: (ctx.extra.ideaId as string | null | undefined) ?? null,
        type: "outline",
        format: (ctx.extra.format as string) ?? "article",
        title: outline.title,
        body: outlineToMarkdown(outline),
        sections: JSON.stringify(outline.sections),
        model: ctx.model,
        createdAt: Date.now(),
      };
      await db.insert(pieces).values(row);
      return [row];
    },
  },
  video_outline: {
    key: "video_outline",
    promptKey: "video_outline",
    modelTask: "video_outline",
    defaultCount: 1,
    maxCount: 1,
    rateLimit: { action: "pieces_outline", limit: 5, windowMs: 60_000 },
    strictRetrySuffix: OUTLINE_RETRY_SUFFIX,
    parseFailureMessage:
      "The AI's reply could not be parsed into an outline, even after one stricter retry. Please try again.",
    jsonMode: true,
    maxTokens: 3000,
    parse: (content: string) => {
      const { outline, problem } = parseOutlineJson(content);
      return outline ? { items: [outline] } : { items: [], problem };
    },
    persist: async (db: Db, ctx: PersistContext, items: ParsedOutline[]) => {
      const outline = items[0];
      const row: typeof pieces.$inferSelect = {
        id: crypto.randomUUID(),
        projectId: ctx.project.id,
        problemId: (ctx.extra.problemId as string | null | undefined) ?? null,
        ideaId: (ctx.extra.ideaId as string | null | undefined) ?? null,
        type: "outline",
        format: (ctx.extra.format as string) ?? "video_script",
        title: outline.title,
        body: outlineToMarkdown(outline),
        sections: JSON.stringify(outline.sections),
        model: ctx.model,
        createdAt: Date.now(),
      };
      await db.insert(pieces).values(row);
      return [row];
    },
  },
  // Phase 10 — drafts. These tasks are NEVER run through plain runGeneration:
  // the draft route enforces the (stricter) pieces_draft rate limit once per
  // request and then calls runGenerationCore once per outline section with
  // skipPersist, storing one combined markdown row at the end.
  article_draft: {
    key: "article_draft",
    promptKey: "article_draft",
    modelTask: "article_draft",
    defaultCount: 1,
    maxCount: 1,
    rateLimit: { action: "pieces_draft", limit: 3, windowMs: 60_000 },
    strictRetrySuffix:
      "Your previous reply was empty or unusable. Respond with ONLY the markdown for the requested section, starting with its exact heading as a markdown H2. No commentary.",
    parseFailureMessage:
      "A section came back empty even after one stricter retry. Please try writing the draft again.",
    jsonMode: false, // prose, not JSON — response_format json_object would corrupt it
    maxTokens: 2000,
    parse: (content: string) => {
      const text = content.trim();
      return text ? { items: [text] } : { items: [], problem: "The section came back empty." };
    },
    persist: async () => [], // never persisted per section — see the task comment
  },
  video_script: {
    key: "video_script",
    promptKey: "video_script",
    modelTask: "video_script",
    defaultCount: 1,
    maxCount: 1,
    rateLimit: { action: "pieces_draft", limit: 3, windowMs: 60_000 },
    strictRetrySuffix:
      "Your previous reply was empty or unusable. Respond with ONLY the markdown for the requested segment, starting with its exact heading as a markdown H2. No commentary.",
    parseFailureMessage:
      "A segment came back empty even after one stricter retry. Please try writing the script again.",
    jsonMode: false,
    maxTokens: 2000,
    parse: (content: string) => {
      const text = content.trim();
      return text ? { items: [text] } : { items: [], problem: "The segment came back empty." };
    },
    persist: async () => [],
  },
};

export type IdeasTask = GenerationTask<ParsedIdea, typeof articleIdeas.$inferSelect>;
export type ProblemsTask = GenerationTask<ParsedProblem, typeof problems.$inferSelect>;

/**
 * Shared generation pipeline behind every generate route: rate limit → key
 * decrypt → model + prompt resolution → provider call → parse (one stricter
 * retry) → persist. Provider failures surface as the typed error taxonomy via
 * the shared status map; nothing sensitive is ever echoed back.
 */
export async function runGeneration<TItem, TRow>(
  env: WorkerEnv,
  project: ProjectRow,
  actorUserId: string,
  task: GenerationTask<TItem, TRow>,
  params: RunGenerationParams = {},
): Promise<GenerationResult<TItem, TRow>> {
  // Cheap rejection BEFORE any config read / key decrypt / provider call.
  await enforceRateLimit(
    getDb(env),
    `${project.id}:${task.rateLimit.action}`,
    task.rateLimit.limit,
    task.rateLimit.windowMs,
  );
  return runGenerationCore(env, project, actorUserId, task, params);
}

/**
 * runGeneration without the rate limit: the shared key decrypt → model +
 * prompt resolution → provider call → parse/retry → persist pipeline. Exported
 * for the Phase 10 draft flow, which applies its limiter ONCE per request and
 * then calls this once per outline section.
 */
export async function runGenerationCore<TItem, TRow>(
  env: WorkerEnv,
  project: ProjectRow,
  actorUserId: string,
  task: GenerationTask<TItem, TRow>,
  params: RunGenerationParams = {},
): Promise<GenerationResult<TItem, TRow>> {
  const count = params.count ?? task.defaultCount;
  const db = getDb(env);

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
    apiKey = await decryptString(configRow.apiKeyEncrypted, env.ENCRYPTION_KEY);
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
  const model = await effectiveModel(db, project.id, task.modelTask);
  const [systemBody, taskBody] = await Promise.all([
    resolvePromptBody(db, project.id, SYSTEM_PROMPT_KEY),
    resolvePromptBody(db, project.id, task.promptKey),
  ]);
  const vars: Record<string, string> = {
    ...projectPromptVariables(project),
    count: String(count),
    ...params.vars,
  };
  const system = renderTemplate(systemBody, vars);
  const user = renderTemplate(taskBody, vars);
  // Informational: unresolved {{variables}} surface as warnings, never a failure.
  const warnings = [...new Set([...system.unknown, ...user.unknown])].map(
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
        json: task.jsonMode,
        maxTokens: task.maxTokens ?? generateMaxTokens(count),
      });
    } catch (err) {
      if (err instanceof OpenRouterError) {
        throw new CodedHTTPException(httpStatusForError(err), err.message, err.code);
      }
      throw err as Error;
    }
  };

  const content = await callModel(user.text);

  let parsed = task.parse(content, count);
  let usedRetry = false;
  if (parsed.problem) {
    // One retry with a stricter instruction, per plan §5. The raw reply is
    // logged (truncated) on the first failure only, to make parse drift
    // diagnosable — replies are model output, never secret material.
    console.error(`[${task.promptKey}] unparsable model reply:`, content.slice(0, 600));
    usedRetry = true;
    const retryContent = await callModel(`${user.text}\n\n${task.strictRetrySuffix}`);
    parsed = task.parse(retryContent, count);
    if (parsed.problem) {
      throw new CodedHTTPException(502, task.parseFailureMessage, "GenerationFailed");
    }
  }

  // One atomic multi-row INSERT: all rows land or none do. Skipped for
  // per-section draft calls (params.skipPersist) — the draft route stores one
  // combined row after the last section lands.
  const rows = params.skipPersist
    ? []
    : await task.persist(
        db,
        { project, actorUserId, model, extra: params.extra ?? {} },
        parsed.items,
      );

  return { rows, items: parsed.items, model, usedRetry, warnings };
}
