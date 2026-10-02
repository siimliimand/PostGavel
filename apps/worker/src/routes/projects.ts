import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb } from "../db/client";
import {
  articleIdeas,
  pieces,
  problems,
  projectAiConfig,
  projectMembers,
  projectModels,
  projects,
  promptTemplates,
} from "../db/schema";
import { createProjectSchema, parseBody, projectIdParams, updateProjectSchema, validParams } from "./validation";

export const projectRoutes = new Hono<AppEnv>();

// Garbage project ids 400 (ValidationError) before any DB lookup.
projectRoutes.use("/:projectId", validParams(projectIdParams));
projectRoutes.use("/:projectId/*", validParams(projectIdParams));

type ProjectRow = typeof projects.$inferSelect;

// Brief fields that may be updated via PUT, after zod validation.
type ProjectUpdateFields = Pick<
  ProjectRow,
  | "name"
  | "description"
  | "contentGuidelines"
  | "contentTypes"
  | "tone"
  | "audienceExpertise"
  | "audienceDescription"
  | "guidelinesAlways"
  | "guidelinesNever"
>;

// Canonical storage format for content types: comma-joined. Deduped
// case-insensitively (first occurrence wins) so "SEO article" and
// "seo article" can't both land in the list; order is preserved.
function joinContentTypes(types: string[]): string {
  const seen = new Set<string>();
  return types
    .filter((type) => {
      const key = type.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(",");
}

// API shape is snake_case, matching the column names in plan §3. content_types
// is exposed as a string array (split on comma) — the UI is the only consumer
// and the canonical format going forward (Phase 8).
function projectJson(p: ProjectRow) {
  return {
    id: p.id,
    owner_user_id: p.ownerUserId,
    name: p.name,
    description: p.description,
    content_guidelines: p.contentGuidelines,
    content_types: p.contentTypes ? p.contentTypes.split(",") : [],
    tone: p.tone,
    audience_expertise: p.audienceExpertise,
    audience_description: p.audienceDescription,
    guidelines_always: p.guidelinesAlways,
    guidelines_never: p.guidelinesNever,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

projectRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const rows = await getDb(c.env)
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, actor.userId))
    .orderBy(desc(projects.createdAt));
  return c.json(rows.map(({ project, role }) => ({ ...projectJson(project), role })));
});

projectRoutes.post("/", async (c) => {
  const { name } = await parseBody(c, createProjectSchema);

  const actor = c.get("actor");
  const db = getDb(c.env);
  const now = Date.now();
  const project: ProjectRow = {
    id: crypto.randomUUID(),
    ownerUserId: actor.userId,
    name,
    description: null,
    contentGuidelines: null,
    contentTypes: null,
    tone: null,
    audienceExpertise: null,
    audienceDescription: null,
    guidelinesAlways: null,
    guidelinesNever: null,
    createdAt: now,
    updatedAt: now,
  };
  // D1 batch = one atomic transaction: project and owner membership land together.
  await db.batch([
    db.insert(projects).values(project),
    db.insert(projectMembers).values({ projectId: project.id, userId: actor.userId, role: "owner" }),
  ]);
  return c.json(projectJson(project), 201);
});

projectRoutes.get("/:projectId", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"));
  return c.json(projectJson(project));
});

projectRoutes.put("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProject(c, projectId); // any role may edit the brief (editor+)

  // Partial update: only the keys present in the body are applied; the refine
  // in the schema guarantees at least one recognized key.
  const fields = await parseBody(c, updateProjectSchema);
  const updates: Partial<ProjectUpdateFields> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.content_guidelines !== undefined) updates.contentGuidelines = fields.content_guidelines;
  if (fields.content_types !== undefined) updates.contentTypes = joinContentTypes(fields.content_types);
  if (fields.tone !== undefined) updates.tone = fields.tone;
  if (fields.audience_expertise !== undefined) updates.audienceExpertise = fields.audience_expertise;
  if (fields.audience_description !== undefined) {
    updates.audienceDescription = fields.audience_description;
  }
  if (fields.guidelines_always !== undefined) updates.guidelinesAlways = fields.guidelines_always;
  if (fields.guidelines_never !== undefined) updates.guidelinesNever = fields.guidelines_never;

  const [updated] = await getDb(c.env)
    .update(projects)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .returning();
  return c.json(projectJson(updated));
});

projectRoutes.delete("/:projectId", async (c) => {
  const { project } = await requireProject(c, c.req.param("projectId"), "owner");
  const db = getDb(c.env);
  // D1 enforces foreign keys and we don't rely on ON DELETE cascade, so child
  // rows go first - all statements in one atomic batch with the project row.
  // (ideas.problem_id is ON DELETE SET NULL, but the ideas rows are already
  // gone by the time problems are deleted.)
  await db.batch([
    db.delete(projectMembers).where(eq(projectMembers.projectId, project.id)),
    db.delete(projectAiConfig).where(eq(projectAiConfig.projectId, project.id)),
    db.delete(projectModels).where(eq(projectModels.projectId, project.id)),
    db.delete(promptTemplates).where(eq(promptTemplates.projectId, project.id)),
    db.delete(pieces).where(eq(pieces.projectId, project.id)),
    db.delete(articleIdeas).where(eq(articleIdeas.projectId, project.id)),
    db.delete(problems).where(eq(problems.projectId, project.id)),
    db.delete(projects).where(eq(projects.id, project.id)),
  ]);
  return c.body(null, 204);
});
