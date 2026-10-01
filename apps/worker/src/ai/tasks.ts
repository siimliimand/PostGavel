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
];

export const TASK_KEYS: readonly string[] = TASKS.map((t) => t.key);

export function defaultModelFor(taskKey: string): string | undefined {
  return TASKS.find((t) => t.key === taskKey)?.defaultModel;
}
