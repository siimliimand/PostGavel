/**
 * Shared lenient JSON parsing for generation tasks (Phase 9 generalization of
 * the Phase 5 ideas parser, plan §5: JSON structured output with one stricter
 * retry). Pure functions only — no I/O, no drizzle/hono imports.
 *
 * The model is asked for structured JSON, but real replies drift. Parsing
 * climbs a leniency ladder before giving up:
 *   1. strip `<think>…</think>` reasoning blocks and markdown fences, and
 *      slice the `[`…`]` span out of prose-wrapped replies;
 *   2. unwrap a top-level object that merely WRAPS the array (json_object mode
 *      cannot emit a bare top-level array on many models, so they answer
 *      `{"ideas": [...]}` / `{"problems": [...]}`) or a double-encoded JSON
 *      string;
 *   3. accept a single bare item object as a one-element array;
 *   4. map drifted field names onto the canonical fields via per-field alias
 *      lists (e.g. `name`/`headline` → title).
 * Items that are still not usable are dropped instead of failing the whole
 * generation; producing zero usable items is reported as a `problem` so the
 * caller can run its single stricter retry.
 */

export type FieldSpec = {
  /** Accepted source keys, in priority order. */
  aliases: string[];
  /** Longer values are truncated silently, never rejected. */
  maxLength: number;
  /** Must be non-empty after trim for the item to be usable. */
  required: boolean;
};

export type LenientParseOptions = {
  /** Wrapper keys a json_object reply commonly uses, checked in order before
   * falling back to the first array-valued property. */
  wrapperKeys: string[];
  /** Canonical field name → spec. */
  fields: Record<string, FieldSpec>;
  /** Noun used in the `problem` messages ("ideas" / "problems"). */
  noun: string;
};

export type ParsedItem = Record<string, string>;

export type LenientParseResult = {
  items: ParsedItem[];
  /** Why parsing produced zero items (parse error vs. no valid items). */
  problem?: string;
};

/** Removes reasoning-model `<think>…</think>` blocks (any case, across lines).
 * Exported for the outline parser (src/ai/outline.ts), whose reply shape is a
 * single object rather than an item array, so it runs its own ladder. */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

/** Strips the first ```/```json fence pair, keeping the payload inside. */
export function stripFences(text: string): string {
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

/** The items array inside a wrapper object: a known wrapper key first, else
 * the first property whose value is an array. Null when none. */
function unwrapWrapper(record: Record<string, unknown>, wrapperKeys: string[]): unknown[] | null {
  for (const key of wrapperKeys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** True when the record plausibly IS one item rather than a wrapper: every
 * required field is present under an accepted alias. */
function looksLikeItem(record: Record<string, unknown>, options: LenientParseOptions): boolean {
  return Object.values(options.fields).every(
    (spec) => !spec.required || firstString(record, spec.aliases) !== null,
  );
}

/**
 * Parse a model reply into at most `requestedCount` validated items, one
 * record per item with canonical field names. Never throws: any failure comes
 * back as `{ items: [], problem }`.
 */
export function parseJsonItems(
  content: string,
  requestedCount: number,
  options: LenientParseOptions,
): LenientParseResult {
  const limit = Math.max(0, Math.trunc(requestedCount));

  let text = stripFences(stripThinkBlocks(content.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const sliced = sliceToArray(text);
    if (sliced === null || sliced === text) {
      return { items: [], problem: "The model reply was not valid JSON." };
    }
    try {
      parsed = JSON.parse(sliced);
    } catch {
      return { items: [], problem: "The model reply contained no parsable JSON array." };
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
    const unwrapped = unwrapWrapper(parsed, options.wrapperKeys);
    if (unwrapped) {
      entries = unwrapped;
    } else if (looksLikeItem(parsed, options)) {
      entries = [parsed]; // count=1 replies are often a single bare object
    } else {
      return {
        items: [],
        problem: `The model reply was valid JSON but contained no array of ${options.noun}.`,
      };
    }
  } else {
    return { items: [], problem: "The model reply was valid JSON but not an array." };
  }

  const items: ParsedItem[] = [];
  for (const entry of entries) {
    if (items.length >= limit) break; // keep the first N valid items
    if (!isRecord(entry)) continue;
    const item: ParsedItem = {};
    let usable = true;
    for (const [name, spec] of Object.entries(options.fields)) {
      const value = firstString(entry, spec.aliases);
      if (value === null) {
        if (spec.required) usable = false;
        continue;
      }
      const clean = value.trim().slice(0, spec.maxLength);
      if (spec.required && !clean) usable = false; // empty after trim = unusable
      item[name] = clean;
    }
    if (usable) items.push(item);
  }

  if (items.length === 0) {
    const requiredNames = Object.entries(options.fields)
      .filter(([, spec]) => spec.required)
      .map(([name]) => name);
    return {
      items: [],
      problem: `The model reply contained no valid ${options.noun} — each item needs a non-empty ${requiredNames.join(" and ")}.`,
    };
  }
  return { items };
}
