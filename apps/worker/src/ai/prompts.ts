/**
 * Prompt variable substitution engine (plan §4/§5).
 *
 * Semantics — robustness beats strictness (plan §4: prompt bodies are freely
 * editable by users, so substitution must never fail on odd input):
 * - A variable token is `{{name}}` with optional inner whitespace (`{{ name }}`);
 *   the name is a simple identifier ([A-Za-z_][A-Za-z0-9_]*).
 * - Known tokens are replaced with `vars[name] ?? ""` — a variable that is
 *   known but has no value renders as an empty string (e.g. an unset topic_hint).
 * - Unknown tokens (no value provided) are left verbatim in the output and
 *   reported in `unknown[]` — the plan's strict unknown-variable warning.
 *   Callers surface the warning in the API/UI instead of failing the request.
 * - Text that does not match the token shape (e.g. `{x}` or `{{not-an-id}}`)
 *   is not a variable and passes through untouched, silently.
 *
 * Both functions are pure (no I/O) and unit-testable by inspection.
 */

/**
 * The brief→prompt variable map (Phase 8). Single source of truth shared by
 * the prompts `/resolved` route and the ideas generate route so the two can
 * never drift; request params (`count`, `topic_hint`) stay layered on top by
 * the generate route. Every variable is always present — a null brief field
 * renders as "" so unset fields collapse to an empty labeled line.
 */
export function projectPromptVariables(project: {
  description: string | null;
  contentGuidelines: string | null;
  contentTypes: string | null;
  tone: string | null;
  audienceDescription: string | null;
  audienceExpertise: string | null;
  guidelinesAlways: string | null;
  guidelinesNever: string | null;
}): Record<string, string> {
  return {
    project_description: project.description ?? "",
    content_guidelines: project.contentGuidelines ?? "",
    content_types: project.contentTypes ?? "",
    tone: project.tone ?? "",
    audience_description: project.audienceDescription ?? "",
    audience_expertise: project.audienceExpertise ?? "",
    guidelines_always: project.guidelinesAlways ?? "",
    guidelines_never: project.guidelinesNever ?? "",
  };
}

/**
 * The `{{problem_context}}` variable for a generation scoped to one audience
 * problem (Phase 9). Shared by the ideas and pieces generate routes so the
 * wording injected into the prompts cannot drift.
 */
export function problemContext(problem: {
  title: string;
  description: string | null;
  searchSignals: string | null;
}): string {
  const description = problem.description ? ` — ${problem.description}` : "";
  return `Problem to address: ${problem.title}${description}. Search signals: ${problem.searchSignals ?? ""}.`;
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** All `{{name}}` tokens in `body`, in order of first appearance, deduplicated. */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Substitute `{{name}}` tokens with values from `vars`. Known variables render
 * their value (missing value = ""), unknown ones stay verbatim and are listed
 * in `unknown[]` (first-appearance order, deduplicated).
 */
export function renderTemplate(
  body: string,
  vars: Record<string, string>,
): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = body.replace(VARIABLE_PATTERN, (token, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      if (!unknown.includes(name)) unknown.push(name);
      return token; // left verbatim: the unknown-variable warning
    }
    return value ?? "";
  });
  return { text, unknown };
}
