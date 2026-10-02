/**
 * Outline output parsing (Phase 10). Unlike ideas/problems, an outline reply
 * is a single JSON object `{"title": "...", "sections": [{"heading", "points":
 * [...]}]}` — so it cannot reuse the shared item-array parser, but it climbs
 * the same leniency ladder (strip `<think>` blocks and fences, unwrap a
 * double-encoded JSON string, alias-drifted field names, drop junk entries
 * instead of failing the whole reply).
 */

import { stripFences, stripThinkBlocks } from "./json";

/** Field caps — longer values are truncated silently, never rejected. */
export const MAX_OUTLINE_TITLE_LENGTH = 200; // matches the pieces.title column
export const MAX_OUTLINE_HEADING_LENGTH = 200;
export const MAX_OUTLINE_POINT_LENGTH = 500;

/** Appended to the user prompt for the one strict retry after a parse failure.
 * A wrapping object around title/sections is accepted, because json_object
 * replies sometimes nest the payload one level deep. */
export const STRICT_RETRY_SUFFIX =
  'Your previous reply could not be parsed. Respond with ONLY valid JSON: a single JSON object shaped {"title": string, "sections": [{"heading": string, "points": [string]}]}. No markdown fences, no commentary, nothing else.';

/** Aliases real replies drift onto, checked in priority order. */
const TITLE_ALIASES = ["title", "name", "working_title", "headline"];
const SECTIONS_ALIASES = ["sections", "segments", "outline", "chapters"];
const HEADING_ALIASES = ["heading", "title", "name", "segment", "section"];
const POINTS_ALIASES = ["points", "beats", "key_points", "bullet_points", "items"];

export type ParsedOutlineSection = { heading: string; points: string[] };

export type ParsedOutline = {
  title: string;
  sections: ParsedOutlineSection[];
};

export type ParseOutlineResult = {
  outline: ParsedOutline | null;
  /** Why parsing produced no usable outline (parse error vs. no sections). */
  problem?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** Points tolerate mixed junk: non-strings and empties are dropped, the rest
 * are trimmed and length-capped. */
function parsePoints(value: unknown[] | null): string[] {
  if (!value) return [];
  const points: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim().slice(0, MAX_OUTLINE_POINT_LENGTH);
    if (clean) points.push(clean);
  }
  return points;
}

/**
 * Parse a model reply into one outline. Never throws: any failure comes back
 * as `{ outline: null, problem }`.
 */
export function parseOutlineJson(content: string): ParseOutlineResult {
  const text = stripFences(stripThinkBlocks(content.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outline: null, problem: "The model reply was not valid JSON." };
  }
  if (typeof parsed === "string") {
    // Some models double-encode: the content is a JSON *string* holding the JSON.
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Still a string; the shape checks below reject it.
    }
  }
  if (!isRecord(parsed)) {
    return { outline: null, problem: "The model reply was not a JSON object." };
  }

  const rawTitle = firstString(parsed, TITLE_ALIASES)?.trim().slice(0, MAX_OUTLINE_TITLE_LENGTH);
  if (!rawTitle) {
    return {
      outline: null,
      problem: "The outline reply had no usable title.",
    };
  }

  const rawSections = firstArray(parsed, SECTIONS_ALIASES);
  if (!rawSections) {
    return {
      outline: null,
      problem: "The outline reply contained no sections array.",
    };
  }

  // Junk rows (non-objects, missing heading) are dropped, not fatal — same
  // policy as the item-array parser.
  const sections: ParsedOutlineSection[] = [];
  for (const entry of rawSections) {
    if (!isRecord(entry)) continue;
    const heading = firstString(entry, HEADING_ALIASES)?.trim().slice(0, MAX_OUTLINE_HEADING_LENGTH);
    if (!heading) continue;
    sections.push({ heading, points: parsePoints(firstArray(entry, POINTS_ALIASES)) });
  }
  if (sections.length === 0) {
    return {
      outline: null,
      problem: "The outline reply contained no sections with a heading.",
    };
  }

  return { outline: { title: rawTitle, sections } };
}

/**
 * Markdown render of an outline: `# <title>` then per section `## <heading>`
 * followed by `- <point>` bullets. This exact text is stored as the outline
 * row's body AND passed back to the draft prompts as {{outline_markdown}}, so
 * what the reviewer approved is what the writer sees.
 */
export function outlineToMarkdown(outline: ParsedOutline): string {
  const lines: string[] = [`# ${outline.title}`, ""];
  for (const section of outline.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const point of section.points) lines.push(`- ${point}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
