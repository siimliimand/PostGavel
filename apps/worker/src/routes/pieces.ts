import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { problemContext } from "../ai/prompts";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb } from "../db/client";
import { enforceRateLimit } from "../db/rateLimit";
import { articleIdeas, derivatives, pieces, problems } from "../db/schema";
import { runGeneration, runGenerationCore, GENERATION_TASKS } from "../tasks/registry";
import {
  createDraftSchema,
  createDerivativeSchema,
  createOutlineSchema,
  parseBody,
  pieceParams,
  projectIdParams,
  validParams,
} from "./validation";
import { CodedHTTPException } from "./errors";

export const pieceRoutes = new Hono<AppEnv>();

const LIST_LIMIT = 200;
/** Tail kept of the already-written sections, for the draft continuity var. */
const PREVIOUS_SECTIONS_TAIL = 3000;
/** Tail cap on {{draft_markdown}} — a safety ceiling for very long drafts. */
const DRAFT_MARKDOWN_TAIL = 12_000;

// Garbage project ids 400 (ValidationError) before any DB lookup. (:pieceId is
// validated inline on DELETE and on POST …/derivatives — a
// `use("/…/pieces/:pieceId")` middleware would also capture the literal
// "outlines"/"drafts" segments.)
pieceRoutes.use("/:projectId", validParams(projectIdParams));
pieceRoutes.use("/:projectId/*", validParams(projectIdParams));

type PieceRow = typeof pieces.$inferSelect;

type StoredSection = { heading: string; points: string[] };

type DerivativeRow = typeof derivatives.$inferSelect;

/** API shape is snake_case, matching the column names in plan §3. `sections`
 * is exchanged as the parsed array (null on drafts), not the raw JSON. Draft
 * pieces carry their publish-kit `derivatives` (Phase 11); outlines an empty
 * array. */
function pieceJson(row: PieceRow, derivativeRows: DerivativeRow[] = []) {
  return {
    id: row.id,
    problem_id: row.problemId,
    idea_id: row.ideaId,
    type: row.type,
    format: row.format,
    title: row.title,
    body: row.body,
    sections: parseStoredSections(row.sections),
    model: row.model,
    created_at: new Date(row.createdAt).toISOString(),
    derivatives: derivativeRows.map(derivativeJson),
  };
}

/** API shape for one publish-kit derivative (Phase 11). `body` is the JSON
 * string for meta / youtube_package, plain text/markdown for the prose kinds. */
function derivativeJson(row: DerivativeRow) {
  return {
    id: row.id,
    draft_piece_id: row.draftPieceId,
    kind: row.kind,
    body: row.body,
    model: row.model,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * The registry task for a (format, kind) publish-kit combination; undefined =
 * invalid for that format (article → meta/linkedin_post/x_thread/
 * newsletter_blurb, video_script → youtube_package).
 */
function derivativeTask(format: string, kind: string) {
  switch (kind) {
    // The body kind "meta" is produced by the registry task "meta_package".
    case "meta":
      return format === "article" ? GENERATION_TASKS.meta_package : undefined;
    case "linkedin_post":
      return format === "article" ? GENERATION_TASKS.linkedin_post : undefined;
    case "x_thread":
      return format === "article" ? GENERATION_TASKS.x_thread : undefined;
    case "newsletter_blurb":
      return format === "article" ? GENERATION_TASKS.newsletter_blurb : undefined;
    case "youtube_package":
      return format === "video_script" ? GENERATION_TASKS.youtube_package : undefined;
    default:
      return undefined;
  }
}

/** The `sections` JSON column → validated array; null when absent/corrupt. */
function parseStoredSections(raw: string | null): StoredSection[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sections: StoredSection[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { heading, points } = entry as Record<string, unknown>;
    if (typeof heading !== "string" || !heading.trim()) continue;
    sections.push({
      heading,
      points: Array.isArray(points)
        ? points.filter((point): point is string => typeof point === "string")
        : [],
    });
  }
  return sections;
}

/** Last `max` characters of `text`, cut at the first newline after the start
 * so the draft prompt never opens with half a sentence. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
}

/**
 * POST /api/projects/:id/pieces/outlines `{ idea_id, format }` — editor+ (it
 * spends credits). Generates an outline from the idea through the shared
 * pipeline (registry tasks article_outline / video_outline). The idea must
 * belong to this project (400 ValidationError otherwise); the outline
 * inherits the idea's problem link, and `{{problem_context}}` is built from
 * that problem when it still exists.
 */
pieceRoutes.post("/:projectId/pieces/outlines", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const actor = c.get("actor");
  const { idea_id: ideaId, format } = await parseBody(c, createOutlineSchema);
  const db = getDb(c.env);

  const [idea] = await db
    .select()
    .from(articleIdeas)
    .where(and(eq(articleIdeas.id, ideaId), eq(articleIdeas.projectId, project.id)))
    .limit(1);
  if (!idea) {
    throw new CodedHTTPException(400, "idea_id does not belong to this project", "ValidationError");
  }

  // The outline inherits the idea's problem scope; a problem deleted since
  // (dangling link after SET NULL) degrades to an empty problem_context.
  let problem: typeof problems.$inferSelect | undefined;
  if (idea.problemId) {
    [problem] = await db
      .select()
      .from(problems)
      .where(and(eq(problems.id, idea.problemId), eq(problems.projectId, project.id)))
      .limit(1);
  }

  const task = format === "article" ? GENERATION_TASKS.article_outline : GENERATION_TASKS.video_outline;
  const result = await runGeneration(c.env, project, actor.userId, task, {
    vars: {
      idea_title: idea.title,
      idea_description: idea.angle,
      problem_context: problem ? problemContext(problem) : "",
    },
    extra: { format, ideaId: idea.id, problemId: idea.problemId },
  });

  return c.json(
    {
      piece: pieceJson(result.rows[0]),
      model: result.model,
      used_retry: result.usedRetry,
      ...(result.warnings.length > 0 ? { prompt_warnings: result.warnings } : {}),
    },
    201,
  );
});

/**
 * POST /api/projects/:id/pieces/drafts `{ outline_id }` — editor+ (it spends
 * credits, several small calls). Writes ONE draft row section-by-section from
 * an approved outline: one model call per section in order, each seeing the
 * full outline and the already-written text for continuity. The rate limit
 * applies ONCE per request, never per section call. The first failed section
 * aborts the whole draft — nothing partial is ever stored.
 */
pieceRoutes.post("/:projectId/pieces/drafts", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const actor = c.get("actor");
  const { outline_id: outlineId } = await parseBody(c, createDraftSchema);
  const db = getDb(c.env);

  const [outline] = await db
    .select()
    .from(pieces)
    .where(and(eq(pieces.id, outlineId), eq(pieces.projectId, project.id)))
    .limit(1);
  if (!outline || outline.type !== "outline") {
    throw new CodedHTTPException(
      400,
      "outline_id must be an outline piece of this project",
      "ValidationError",
    );
  }
  const sections = parseStoredSections(outline.sections);
  if (!sections || sections.length === 0) {
    throw new CodedHTTPException(
      400,
      "This outline has no parsable sections to write from — generate it again.",
      "ValidationError",
    );
  }

  const task =
    outline.format === "article" ? GENERATION_TASKS.article_draft : GENERATION_TASKS.video_script;

  // Once per draft request — the per-section calls below must NOT hit the
  // limiter (runGenerationCore is runGeneration minus exactly that).
  await enforceRateLimit(
    db,
    `${project.id}:${task.rateLimit.action}`,
    task.rateLimit.limit,
    task.rateLimit.windowMs,
  );

  const written: string[] = [];
  let model = outline.model ?? "";
  for (const section of sections) {
    const result = await runGenerationCore(c.env, project, actor.userId, task, {
      vars: {
        outline_markdown: outline.body,
        section_heading: section.heading,
        section_points: section.points.join("; "),
        previous_sections: tail(written.join("\n\n"), PREVIOUS_SECTIONS_TAIL),
      },
      skipPersist: true,
    });
    model = result.model;
    written.push(result.items[0]);
  }

  // The one row the whole draft stores: title from the approved outline, body
  // = H1 title + the section texts joined with blank lines.
  const [row] = await db
    .insert(pieces)
    .values({
      id: crypto.randomUUID(),
      projectId: project.id,
      problemId: outline.problemId,
      ideaId: outline.ideaId,
      type: "draft",
      format: outline.format,
      title: outline.title,
      body: `# ${outline.title}\n\n${written.join("\n\n")}`,
      sections: null,
      model,
      createdAt: Date.now(),
    })
    .returning();

  return c.json({ piece: pieceJson(row), model }, 201);
});

/** GET /api/projects/:id/pieces — member read, newest first (bodies included).
 * Draft pieces nest their publish-kit `derivatives` (Phase 11). */
pieceRoutes.get("/:projectId/pieces", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(pieces)
    .where(eq(pieces.projectId, project.id))
    .orderBy(desc(pieces.createdAt), desc(pieces.id))
    .limit(LIST_LIMIT);
  // One query for every derivative of these pieces, grouped by draft. (The
  // derivatives table has no project_id — they hang off their draft.)
  const derivativeRows =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(derivatives)
          .where(
            inArray(
              derivatives.draftPieceId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(derivatives.createdAt, derivatives.id);
  const byDraft = new Map<string, DerivativeRow[]>();
  for (const row of derivativeRows) {
    const list = byDraft.get(row.draftPieceId);
    if (list) list.push(row);
    else byDraft.set(row.draftPieceId, [row]);
  }
  return c.json(rows.map((row) => pieceJson(row, byDraft.get(row.id) ?? [])));
});

/**
 * POST /api/projects/:id/pieces/:pieceId/derivatives `{ kind }` — editor+ (it
 * spends credits). Generates ONE publish-kit derivative from the draft + the
 * project brief through the shared pipeline (registry tasks meta_package,
 * linkedin_post, x_thread, newsletter_blurb, youtube_package — a single model
 * call each). The piece must be a DRAFT of this project (400 otherwise) and
 * the kind must be valid for its format (400 otherwise). Persist is an upsert
 * on (draft_piece_id, kind): regenerating replaces (latest wins). The rate
 * limit applies ONCE per request.
 */
pieceRoutes.post(
  "/:projectId/pieces/:pieceId/derivatives",
  validParams(pieceParams),
  async (c) => {
    const { project } = await requireProject(c, c.req.param("projectId"));
    const actor = c.get("actor");
    const { kind } = await parseBody(c, createDerivativeSchema);
    const pieceId = c.req.param("pieceId");
    const db = getDb(c.env);

    const [draft] = await db
      .select()
      .from(pieces)
      .where(and(eq(pieces.id, pieceId), eq(pieces.projectId, project.id)))
      .limit(1);
    if (!draft || draft.type !== "draft") {
      throw new CodedHTTPException(
        400,
        "piece_id must be a draft piece of this project",
        "ValidationError",
      );
    }
    const task = derivativeTask(draft.format, kind);
    if (!task) {
      throw new CodedHTTPException(
        400,
        `kind "${kind}" is not valid for a ${draft.format} draft`,
        "ValidationError",
      );
    }

    // Once per request — the single runGenerationCore call below must not hit
    // the limiter again (same once-only pattern as the Phase 10 draft route).
    await enforceRateLimit(
      db,
      `${project.id}:${task.rateLimit.action}`,
      task.rateLimit.limit,
      task.rateLimit.windowMs,
    );

    // Derivative prompts share the standard context block, so resolve the
    // draft's problem scope (same degrade-to-empty as the outline route —
    // a dangling link after SET NULL yields an empty problem_context).
    let problem: typeof problems.$inferSelect | undefined;
    if (draft.problemId) {
      [problem] = await db
        .select()
        .from(problems)
        .where(and(eq(problems.id, draft.problemId), eq(problems.projectId, project.id)))
        .limit(1);
    }

    const result = await runGenerationCore(c.env, project, actor.userId, task, {
      vars: {
        draft_markdown: tail(draft.body, DRAFT_MARKDOWN_TAIL),
        problem_context: problem ? problemContext(problem) : "",
      },
      extra: { draftPieceId: draft.id, kind },
    });

    return c.json(
      {
        derivative: derivativeJson(result.rows[0]),
        model: result.model,
        used_retry: result.usedRetry,
        ...(result.warnings.length > 0 ? { prompt_warnings: result.warnings } : {}),
      },
      201,
    );
  },
);

/** DELETE /api/projects/:id/pieces/:pieceId — editor+, scoped to the project. */
pieceRoutes.delete(
  "/:projectId/pieces/:pieceId",
  validParams(pieceParams),
  async (c) => {
    const { project } = await requireProject(c, c.req.param("projectId"));
    const removed = await getDb(c.env)
      .delete(pieces)
      .where(and(eq(pieces.projectId, project.id), eq(pieces.id, c.req.param("pieceId"))))
      .returning();
    if (removed.length === 0) throw new HTTPException(404, { message: "Piece not found" });
    return c.body(null, 204);
  },
);
