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
