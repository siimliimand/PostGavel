/**
 * Problem output parsing (Phase 9). Thin configuration over the shared lenient
 * parser (src/ai/json.ts) — same leniency ladder as ideas (`<think>` strip,
 * json_object wrapper unwrap, alias mapping), but for
 * `{"problems": [{"title", "description", "search_signals"}]}` replies.
 */

import { parseJsonItems, type LenientParseOptions } from "./json";

/** Field caps — longer values are truncated silently, never rejected. */
export const MAX_PROBLEM_TITLE_LENGTH = 120;
export const MAX_PROBLEM_DESCRIPTION_LENGTH = 2000;
export const MAX_PROBLEM_SEARCH_SIGNALS_LENGTH = 1000;

/** Appended to the user prompt for the one strict retry after a parse failure.
 * An object wrapping the array is accepted, because `response_format:
 * json_object` cannot emit a bare top-level array on many models. */
export const STRICT_RETRY_SUFFIX =
  'Your previous reply could not be parsed. Respond with ONLY valid JSON: a single JSON object shaped {"problems": [{"title": string, "description": string, "search_signals": string}]}. No markdown fences, no commentary, nothing else.';

const PROBLEM_FIELDS: LenientParseOptions["fields"] = {
  title: {
    aliases: ["title", "problem", "name", "headline"],
    maxLength: MAX_PROBLEM_TITLE_LENGTH,
    required: true,
  },
  description: {
    aliases: ["description", "summary", "detail"],
    maxLength: MAX_PROBLEM_DESCRIPTION_LENGTH,
    required: false,
  },
  search_signals: {
    aliases: ["search_signals", "searchSignals", "signals", "search_queries"],
    maxLength: MAX_PROBLEM_SEARCH_SIGNALS_LENGTH,
    required: false,
  },
};

export type ParsedProblem = { title: string; description?: string; search_signals?: string };

export type ParseProblemsResult = {
  problems: ParsedProblem[];
  /** Why parsing produced zero problems (parse error vs. no valid items). */
  problem?: string;
};

/**
 * Parse a model reply into at most `requestedCount` validated problems.
 * Never throws: any failure comes back as `{ problems: [], problem }`.
 */
export function parseProblemsJson(content: string, requestedCount: number): ParseProblemsResult {
  const { items, problem } = parseJsonItems(content, requestedCount, {
    wrapperKeys: ["problems", "results", "data", "items", "output"],
    fields: PROBLEM_FIELDS,
    noun: "problems",
  });
  return {
    problems: items.map((item) => ({
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(item.search_signals ? { search_signals: item.search_signals } : {}),
    })),
    problem,
  };
}
