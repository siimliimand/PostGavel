/**
 * Idea output parsing (plan §5: JSON structured output with one stricter retry).
 * Pure functions only — no I/O, no drizzle/hono imports — so the parse/validate
 * rules are unit-testable without a worker runtime.
 *
 * The model is asked for a bare JSON array of {"title", "angle"} objects, but
 * real replies drift: markdown fences, preamble prose, trailing commentary,
 * items with missing or empty fields. Parsing tolerates all of that and drops
 * anything that is not a usable idea instead of failing the whole generation
 * for one bad element. Producing zero usable ideas is reported as a `problem`
 * so the caller can run its single stricter retry.
 */

/** Field caps — longer values are truncated silently, never rejected. */
export const MAX_TITLE_LENGTH = 300;
export const MAX_ANGLE_LENGTH = 2000;

/** Appended to the user prompt for the one strict retry after a parse failure. */
export const STRICT_RETRY_SUFFIX =
  'Your previous reply could not be parsed. Respond with ONLY a valid JSON array of {"title": string, "angle": string} objects — no markdown fences, no commentary.';

export type ParsedIdea = { title: string; angle: string };

export type ParseIdeasResult = {
  ideas: ParsedIdea[];
  /** Why parsing produced zero ideas (parse error vs. no valid items). */
  problem?: string;
};

/** Strips the first ```/```json fence pair, keeping the payload inside. */
function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}

/** First `[` to last `]` — drops leading/trailing prose around the array. */
function sliceToArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a model reply into at most `requestedCount` validated ideas.
 * Never throws: any failure comes back as `{ ideas: [], problem }`.
 */
export function parseIdeasJson(content: string, requestedCount: number): ParseIdeasResult {
  const limit = Math.max(0, Math.trunc(requestedCount));

  let parsed: unknown;
  let text = stripFences(content.trim());
  try {
    parsed = JSON.parse(text);
  } catch {
    const sliced = sliceToArray(text);
    if (sliced === null || sliced === text) {
      return { ideas: [], problem: "The model reply was not valid JSON." };
    }
    try {
      parsed = JSON.parse(sliced);
    } catch {
      return { ideas: [], problem: "The model reply contained no parsable JSON array." };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ideas: [], problem: "The model reply was valid JSON but not an array." };
  }

  const ideas: ParsedIdea[] = [];
  for (const entry of parsed) {
    if (ideas.length >= limit) break; // keep the first N valid items
    if (!isRecord(entry)) continue;
    const { title, angle } = entry as { title?: unknown; angle?: unknown };
    if (typeof title !== "string" || typeof angle !== "string") continue;
    const cleanTitle = title.trim().slice(0, MAX_TITLE_LENGTH);
    const cleanAngle = angle.trim().slice(0, MAX_ANGLE_LENGTH);
    if (!cleanTitle || !cleanAngle) continue; // empty after trim = unusable
    ideas.push({ title: cleanTitle, angle: cleanAngle });
  }

  if (ideas.length === 0) {
    return {
      ideas: [],
      problem:
        "The model reply contained no valid ideas — each item needs a non-empty title and angle.",
    };
  }
  return { ideas };
}
