import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireProject } from "../auth/access";
import { findOrCreateUser, type AppEnv, type ProjectRole } from "../auth/actor";
import { getDb } from "../db/client";
import { projectMembers, users } from "../db/schema";
import { readJsonObject } from "./helpers";

export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get("/:projectId/members", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProject(c, projectId);

  const rows = await getDb(c.env)
    .select({
      user_id: users.id,
      email: users.email,
      name: users.name,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    // owners first, then alphabetical for a stable list
    .orderBy(desc(projectMembers.role), users.email);
  return c.json(rows);
});

memberRoutes.post("/:projectId/members", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProject(c, projectId, "owner");

  const body = await readJsonObject(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return c.json({ error: "email must be a non-empty string" }, 400);
  const role = body.role;
  if (role !== "owner" && role !== "editor") {
    return c.json({ error: 'role must be "owner" or "editor"' }, 400);
  }

  const db = getDb(c.env);
  // Lazy user creation, consistent with the actor middleware.
  const user = await findOrCreateUser(db, email, null);

  const [existing] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .limit(1);
  if (existing) return c.json({ error: "User is already a member of this project" }, 409);

  await db.insert(projectMembers).values({ projectId, userId: user.id, role });
  return c.json({ user_id: user.id, email: user.email, name: user.name, role: role satisfies ProjectRole }, 201);
});

memberRoutes.delete("/:projectId/members/:userId", async (c) => {
  const projectId = c.req.param("projectId");
  const { project } = await requireProject(c, projectId, "owner");
  const userId = c.req.param("userId");
  if (userId === project.ownerUserId) {
    return c.json({ error: "The project owner cannot be removed" }, 400);
  }

  const removed = await getDb(c.env)
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .returning();
  if (removed.length === 0) return c.json({ error: "Member not found" }, 404);
  return c.body(null, 204);
});
