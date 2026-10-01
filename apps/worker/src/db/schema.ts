import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Phase 0 placeholder: drizzle-kit needs at least one table to emit an initial
// migration and prove the D1 migration pipeline. Phase 1 replaces this with
// the real schema (see docs/implementation-plan.md §3: users, projects,
// project_members, project_ai_config, project_models, prompt_templates,
// article_ideas) plus seed data.
export const placeholder = sqliteTable("placeholder", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});
