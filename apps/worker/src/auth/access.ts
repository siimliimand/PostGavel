import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { getDb, type Db } from "../db/client";
import { projectMembers, projects } from "../db/schema";
import type { AppEnv, ProjectRole } from "./actor";

const ROLE_RANK: Record<ProjectRole, number> = { editor: 0, owner: 1 };

export async function getProjectRole(db: Db, projectId: string, userId: string): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row ? (row.role as ProjectRole) : null;
}

export type ProjectAccess = {
  project: typeof projects.$inferSelect;
  role: ProjectRole;
};

/**
 * Authorization gate for /api/projects/:projectId/* handlers. Throws an
 * HTTPException that the app-level error envelope turns into
 * { "error": "..." }:
 * - no membership → 404, never leaking that the project exists;
 * - role below the minimum (e.g. editor requesting an owner-only op) → 403.
 * On success returns the project row so handlers don't re-query.
 */
export async function requireProject(
  c: Context<AppEnv>,
  projectId: string,
  min: ProjectRole = "editor",
): Promise<ProjectAccess> {
  const actor = c.get("actor");
  const db = getDb(c.env);
  const role = await getProjectRole(db, projectId, actor.userId);
  if (!role) throw new HTTPException(404, { message: "Project not found" });
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HTTPException(403, { message: "Forbidden" });

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new HTTPException(404, { message: "Project not found" });
  return { project, role };
}
