/**
 * Single source of truth for AI task types (plan §5/§6, assumption 8).
 *
 * Adding a future task ("outline", "draft", "titles", …) is a one-line change
 * here: the AI config UI renders a model picker per entry automatically and
 * prompt/idea phases resolve prompts via `promptKey`.
 */
export type TaskDef = {
  key: string;
  label: string;
  promptKey: string;
  defaultModel: string;
};

export const TASKS: TaskDef[] = [
  {
    key: "idea_generation",
    label: "Article idea generation",
    promptKey: "article_ideas",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    key: "problem_generation",
    label: "Audience problem generation",
    promptKey: "audience_problems",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    key: "article_outline",
    label: "Article outline",
    promptKey: "article_outline",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    key: "video_outline",
    label: "Video outline",
    promptKey: "video_outline",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    key: "article_draft",
    label: "Article draft (one call per section)",
    promptKey: "article_draft",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    key: "video_script",
    label: "Video script (one call per segment)",
    promptKey: "video_script",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    // Phase 11: ALL five publish-kit derivative tasks share this one picker —
    // each registry entry has its own promptKey but modelTask "derivatives".
    key: "derivatives",
    label: "Publish kit derivatives (meta, social, newsletter, YouTube)",
    promptKey: "meta_package",
    defaultModel: "openai/gpt-4o-mini",
  },
];

export const TASK_KEYS: readonly string[] = TASKS.map((t) => t.key);

export function defaultModelFor(taskKey: string): string | undefined {
  return TASKS.find((t) => t.key === taskKey)?.defaultModel;
}
