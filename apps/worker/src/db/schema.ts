import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Conventions (whole schema):
 * - ids are TEXT uuid v4, generated at runtime with crypto.randomUUID();
 *   seed migrations use fixed literal uuids for determinism.
 * - timestamps are INTEGER unix milliseconds (Date.now()), never seconds.
 */

// Accounts. Credentials are owned by this app since Phase 7 (plan §4):
// password_hash is a PHC-style "pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>"
// string managed by auth/passwords.ts. NULL = invited placeholder (a member
// was shared with this email) that has not registered/claimed the account yet.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: integer("created_at").notNull(),
});

// Server-side session store (Phase 7, plan §4). Only SHA-256(token) is stored —
// the raw token lives only in the browser cookie, so a database leak yields no
// usable sessions. Rows are managed entirely by auth/sessions.ts; expired rows
// are deleted lazily on access.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // hex SHA-256 of the session token
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// The workspace unit. The brief fields feed the {{variables}} in prompts.
// content_guidelines is the free-form "Additional notes" escape hatch;
// content_types is a comma-joined list (canonical format since Phase 8 — the
// API exchanges it as a string array). The Phase 8 columns are additive and
// nullable; structured rules live in guidelines_always/guidelines_never.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  contentGuidelines: text("content_guidelines"),
  contentTypes: text("content_types"),
  tone: text("tone"),
  audienceExpertise: text("audience_expertise"),
  audienceDescription: text("audience_description"),
  guidelinesAlways: text("guidelines_always"),
  guidelinesNever: text("guidelines_never"),
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

// Generated output of this iteration. problem_id (Phase 9) links an idea to
// the audience problem it was scoped to; deleting the problem leaves the idea
// in place with the link cleared (ON DELETE SET NULL).
export const articleIdeas = sqliteTable("article_ideas", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  angle: text("angle").notNull(),
  problemId: text("problem_id").references(() => problems.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
});

// Audience problems (Phase 9): concrete, observable problems the project's
// target audience has that the project can credibly address. Problems-first
// ideation: generate/select a problem, then scope article ideas to it.
// source: 'ai' (generated) | 'manual' (added by hand).
export const problems = sqliteTable("problems", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  searchSignals: text("search_signals"),
  source: text("source").notNull().default("ai"),
  createdAt: integer("created_at").notNull(),
});

// Content pieces (Phase 10): outlines and drafts of the article/video
// pipeline. An outline is the human-review gate (structured sections JSON);
// a draft is written section-by-section from an approved outline and stored
// as one markdown body. sections (JSON [{"heading","points":[]}]) is set on
// outlines only. problem_id/idea_id inherit the outline's origin (ON DELETE
// SET NULL — deleting the problem/idea keeps the piece, minus the link).
export const pieces = sqliteTable(
  "pieces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    problemId: text("problem_id").references(() => problems.id, { onDelete: "set null" }),
    ideaId: text("idea_id").references(() => articleIdeas.id, { onDelete: "set null" }),
    type: text("type").notNull(), // 'outline' | 'draft'
    format: text("format").notNull(), // 'article' | 'video_script'
    title: text("title").notNull(),
    body: text("body").notNull(), // markdown
    sections: text("sections"), // JSON, outlines only
    model: text("model"), // provenance: the model that produced the content
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("pieces_project_id_idx").on(t.projectId)],
);

// Fixed-window rate limit counters (Phase 6). One row per
// "{project_id}:{action}", managed entirely by db/rateLimit.ts. A plain D1
// counter (not the beta Workers ratelimit binding) keeps local dev and prod
// on the same code path.
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});
