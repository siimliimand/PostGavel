import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireProject } from "../auth/access";
import type { AppEnv } from "../auth/actor";
import { getDb } from "../db/client";
import {
  articleIdeas,
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

// API shape is snake_case, matching the column names in plan §3.
function projectJson(p: ProjectRow) {
  return {
    id: p.id,
    owner_user_id: p.ownerUserId,
    name: p.name,
    description: p.description,
    content_guidelines: p.contentGuidelines,
    content_types: p.contentTypes,
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
  const updates: Partial<Pick<ProjectRow, "name" | "description" | "contentGuidelines" | "contentTypes">> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.content_guidelines !== undefined) updates.contentGuidelines = fields.content_guidelines;
  if (fields.content_types !== undefined) updates.contentTypes = fields.content_types;

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
  await db.batch([
    db.delete(projectMembers).where(eq(projectMembers.projectId, project.id)),
    db.delete(projectAiConfig).where(eq(projectAiConfig.projectId, project.id)),
    db.delete(projectModels).where(eq(projectModels.projectId, project.id)),
    db.delete(promptTemplates).where(eq(promptTemplates.projectId, project.id)),
    db.delete(articleIdeas).where(eq(articleIdeas.projectId, project.id)),
    db.delete(projects).where(eq(projects.id, project.id)),
  ]);
  return c.body(null, 204);
});
