import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Conventions (whole schema):
 * - ids are TEXT uuid v4, generated at runtime with crypto.randomUUID();
 *   seed migrations use fixed literal uuids for determinism.
 * - timestamps are INTEGER unix milliseconds (Date.now()), never seconds.
 */

// Accounts. Auth-ready: created lazily on first sight; a real auth provider
// owns credentials later (plan §4).
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: integer("created_at").notNull(),
});

// The workspace unit. The three brief fields feed the {{variables}} in prompts.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  contentGuidelines: text("content_guidelines"),
  contentTypes: text("content_types"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Sharing: several accounts on one project. Role: 'owner' | 'editor'.
// Composite PK covers the (project_id, user_id) uniqueness requirement.
export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

// OpenRouter configuration, one row per project. Unconfigured (NULLs) until Phase 3.
export const projectAiConfig = sqliteTable("project_ai_config", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id),
  apiKeyEncrypted: text("api_key_encrypted"),
  apiKeyHint: text("api_key_hint"),
  updatedAt: integer("updated_at").notNull(),
});

// Which model does which task; one row per task type
// ('idea_generation' today, 'outline'/'draft'/... later).
export const projectModels = sqliteTable(
  "project_models",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    taskType: text("task_type").notNull(),
    model: text("model").notNull(),
  },
  (t) => [uniqueIndex("project_models_project_id_task_type_unique").on(t.projectId, t.taskType)],
);

// Prompt templates. Global defaults are seeded (project_id NULL); per-project
// rows override a default by key.
export const promptTemplates = sqliteTable(
  "prompt_templates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id), // NULL = global default
    key: text("key").notNull(),
    name: text("name").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("prompt_templates_project_id_key_unique").on(t.projectId, t.key),
    // SQLite UNIQUE treats NULLs as distinct, so the composite index alone would
    // allow several global defaults with the same key; this partial index keeps
    // keys unique among project_id IS NULL rows.
    uniqueIndex("prompt_templates_global_key_unique")
      .on(t.key)
      .where(sql`project_id IS NULL`),
  ],
);

// Generated output of this iteration (ideas only, no drafts yet).
export const articleIdeas = sqliteTable("article_ideas", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  angle: text("angle").notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
});
