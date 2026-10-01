/**
 * Idea output parsing (plan §5: JSON structured output with one stricter retry).
 * Pure functions only — no I/O, no drizzle/hono imports — so the parse/validate
 * rules are unit-testable without a worker runtime.
 *
 * The model is asked for a bare JSON array of {"title", "angle"} objects, but
 * real replies drift. Parsing climbs a leniency ladder before giving up:
 *   1. strip `<think>…</think>` reasoning blocks and markdown fences, and
 *      slice the `[`…`]` span out of prose-wrapped replies;
 *   2. unwrap a top-level object that merely WRAPS the array (json_object mode
 *      often answers `{"ideas": [...]}`) or a double-encoded JSON string;
 *   3. accept a single bare idea object as a one-element array;
 *   4. map drifted field names (`name`/`headline`…, `summary`/`hook`…)
 *      onto title/angle.
 * Items that are still not usable ideas are dropped instead of failing the
 * whole generation; producing zero usable ideas is reported as a `problem`
 * so the caller can run its single stricter retry.
 */

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
/** Accepted aliases for an item's title field, in priority order. */
const TITLE_KEYS = ["title", "name", "headline", "heading"];
/** Accepted aliases for an item's angle field, in priority order. */
const ANGLE_KEYS = ["angle", "description", "summary", "premise", "take", "hook"];

export type ParsedIdea = { title: string; angle: string };

export type ParseIdeasResult = {
  ideas: ParsedIdea[];
  /** Why parsing produced zero ideas (parse error vs. no valid items). */
  problem?: string;
};

/** Removes reasoning-model `<think>…</think>` blocks (any case, across lines). */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

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

/** First value among `keys` that is a string, in order — null when none is. */
function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/** The ideas array inside a wrapper object (json_object mode cannot emit a
 * bare top-level array on many models, so they wrap it): a known wrapper key
 * first, else the first property whose value is an array. Null when none. */
function unwrapWrapper(record: Record<string, unknown>): unknown[] | null {
  for (const key of WRAPPER_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** True when the record plausibly IS one idea rather than a wrapper: it has a
 * title-ish and an angle-ish field under any accepted alias. */
function looksLikeIdea(record: Record<string, unknown>): boolean {
  return firstString(record, TITLE_KEYS) !== null && firstString(record, ANGLE_KEYS) !== null;
}

/**
 * Parse a model reply into at most `requestedCount` validated ideas.
 * Never throws: any failure comes back as `{ ideas: [], problem }`.
 */
export function parseIdeasJson(content: string, requestedCount: number): ParseIdeasResult {
  const limit = Math.max(0, Math.trunc(requestedCount));

  let text = stripFences(stripThinkBlocks(content.trim()));
  let parsed: unknown;
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

  // Normalization ladder: collapse everything the model might have wrapped
  // around the array into a plain array before validating (see module doc).
  if (typeof parsed === "string") {
    // Some models double-encode: the content is a JSON *string* holding the JSON.
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Still a string; the checks below reject it.
    }
  }

  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed)) {
    const unwrapped = unwrapWrapper(parsed);
    if (unwrapped) {
      entries = unwrapped;
    } else if (looksLikeIdea(parsed)) {
      entries = [parsed]; // count=1 replies are often a single bare object
    } else {
      return {
        ideas: [],
        problem: "The model reply was valid JSON but contained no array of ideas.",
      };
    }
  } else {
    return { ideas: [], problem: "The model reply was valid JSON but not an array." };
  }

  const ideas: ParsedIdea[] = [];
  for (const entry of entries) {
    if (ideas.length >= limit) break; // keep the first N valid items
    if (!isRecord(entry)) continue;
    const title = firstString(entry, TITLE_KEYS);
    const angle = firstString(entry, ANGLE_KEYS);
    if (title === null || angle === null) continue;
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
