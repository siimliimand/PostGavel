/**
 * Idea output parsing (plan §5: JSON structured output with one stricter retry).
 * Thin configuration over the shared lenient parser (src/ai/json.ts) — the
 * leniency ladder lives there so the problems task (Phase 9) behaves
 * identically.
 */

import { parseJsonItems, type LenientParseOptions } from "./json";

/** Field caps — longer values are truncated silently, never rejected. */
export const MAX_TITLE_LENGTH = 300;
export const MAX_ANGLE_LENGTH = 2000;

/** Appended to the user prompt for the one strict retry after a parse failure.
 * A bare array OR an object containing the array is accepted, because
 * `response_format: json_object` cannot emit a bare top-level array on many
 * models — they must wrap it. */
export const STRICT_RETRY_SUFFIX =
  'Your previous reply could not be parsed. Respond with ONLY valid JSON: either a bare array of {"title": string, "angle": string} objects, or a single JSON object containing that array (e.g. {"ideas": [...]}). No markdown fences, no commentary, nothing else.';

/** Wrapper keys a json_object reply commonly uses around the ideas array,
 * checked in order before falling back to the first array-valued property. */
const WRAPPER_KEYS = ["ideas", "results", "data", "items", "articles", "suggestions", "output"];

const IDEA_FIELDS: LenientParseOptions["fields"] = {
  title: { aliases: ["title", "name", "headline", "heading"], maxLength: MAX_TITLE_LENGTH, required: true },
  angle: {
    aliases: ["angle", "description", "summary", "premise", "take", "hook"],
    maxLength: MAX_ANGLE_LENGTH,
    required: true,
  },
};

export type ParsedIdea = { title: string; angle: string };

export type ParseIdeasResult = {
  ideas: ParsedIdea[];
  /** Why parsing produced zero ideas (parse error vs. no valid items). */
  problem?: string;
};

/**
 * Parse a model reply into at most `requestedCount` validated ideas.
 * Never throws: any failure comes back as `{ ideas: [], problem }`.
 */
export function parseIdeasJson(content: string, requestedCount: number): ParseIdeasResult {
  const { items, problem } = parseJsonItems(content, requestedCount, {
    wrapperKeys: WRAPPER_KEYS,
    fields: IDEA_FIELDS,
    noun: "ideas",
  });
  return {
    ideas: items.map((item) => ({ title: item.title, angle: item.angle })),
    problem,
  };
}
