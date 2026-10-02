/**
 * Publish kit derivative output parsing (Phase 11). Two reply shapes:
 * - meta_package / youtube_package: a single JSON object, parsed with the same
 *   leniency ladder as outlines (src/ai/outline.ts): strip `<think>` blocks
 *   and markdown fences, unwrap a double-encoded JSON string, alias-drifted
 *   field names, tolerant of array-or-string drift on `titles`.
 * - linkedin_post / x_thread / newsletter_blurb: plain prose — strip think
 *   blocks and fences, trim. Never throws; failures come back as
 *   `{ item: null, problem }` so the caller runs its single stricter retry.
 */

import { stripFences, stripThinkBlocks } from "./json";

/** Field caps — longer values are truncated silently, never rejected. */
export const MAX_META_TITLE_LENGTH = 200;
export const MAX_META_DESCRIPTION_LENGTH = 500;
export const MAX_META_SLUG_LENGTH = 200;
export const MAX_META_EXCERPT_LENGTH = 2000;
export const MAX_YOUTUBE_TITLE_LENGTH = 200;
export const MAX_YOUTUBE_DESCRIPTION_LENGTH = 10_000;
export const MAX_YOUTUBE_TITLES = 10; // keep the first N titles; the prompt asks for 3

export type ParsedMetaPackage = {
  meta_title: string;
  meta_description: string;
  slug: string;
  excerpt: string;
};

export type ParsedYoutubePackage = {
  titles: string[];
  description: string;
};

export type ParseDerivativeResult<T> = {
  item: T | null;
  /** Why parsing produced no usable item (reported before the strict retry). */
  problem?: string;
};

/** Aliases real replies drift onto, checked in priority order. */
const META_TITLE_ALIASES = ["meta_title", "title", "metaTitle", "seo_title", "headline"];
const META_DESCRIPTION_ALIASES = [
  "meta_description",
  "description",
  "metaDescription",
  "meta_desc",
  "seo_description",
];
const META_SLUG_ALIASES = ["slug", "url_slug", "url", "path"];
const META_EXCERPT_ALIASES = ["excerpt", "summary", "teaser", "intro", "standfirst"];
const YT_TITLES_ALIASES = ["titles", "title", "title_options", "video_titles", "options"];
const YT_DESCRIPTION_ALIASES = ["description", "video_description", "desc", "body"];

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

/** A JSON-decoded reply: fences/think stripped, one double-encoding unwrapped.
 * The object shape is checked here so callers get a typed record. */
function decodeJsonReply(
  content: string,
): { parsed: Record<string, unknown> } | { problem: string } {
  const text = stripFences(stripThinkBlocks(content.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "The model reply was not valid JSON." };
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
    return { problem: "The model reply was not a JSON object." };
  }
  return { parsed };
}

/** Parse a meta package reply into its four fields. Never throws. */
export function parseMetaPackage(content: string): ParseDerivativeResult<ParsedMetaPackage> {
  const decoded = decodeJsonReply(content);
  if ("problem" in decoded) return { item: null, problem: decoded.problem };
  const parsed = decoded.parsed;

  const meta_title = firstString(parsed, META_TITLE_ALIASES)?.trim().slice(0, MAX_META_TITLE_LENGTH);
  const meta_description = firstString(parsed, META_DESCRIPTION_ALIASES)
    ?.trim()
    .slice(0, MAX_META_DESCRIPTION_LENGTH);
  const slug = firstString(parsed, META_SLUG_ALIASES)?.trim().slice(0, MAX_META_SLUG_LENGTH);
  const excerpt = firstString(parsed, META_EXCERPT_ALIASES)?.trim().slice(0, MAX_META_EXCERPT_LENGTH);

  if (!meta_title || !meta_description || !slug || !excerpt) {
    return {
      item: null,
      problem: "The meta package reply was missing meta_title, meta_description, slug or excerpt.",
    };
  }
  return { item: { meta_title, meta_description, slug, excerpt } };
}

/** Titles tolerate a single string or an array with junk entries dropped. */
function parseTitles(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const titles: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim().slice(0, MAX_YOUTUBE_TITLE_LENGTH);
    if (clean) titles.push(clean);
    if (titles.length >= MAX_YOUTUBE_TITLES) break;
  }
  return titles;
}

/** Parse a YouTube package reply into titles + description. Never throws. */
export function parseYoutubePackage(content: string): ParseDerivativeResult<ParsedYoutubePackage> {
  const decoded = decodeJsonReply(content);
  if ("problem" in decoded) return { item: null, problem: decoded.problem };
  const parsed = decoded.parsed;

  const rawTitles = Array.isArray(parsed["titles"])
    ? parsed["titles"] // canonical array form wins
    : firstString(parsed, YT_TITLES_ALIASES);
  const titles = parseTitles(rawTitles);
  const description = firstString(parsed, YT_DESCRIPTION_ALIASES)
    ?.trim()
    .slice(0, MAX_YOUTUBE_DESCRIPTION_LENGTH);

  if (titles.length === 0 || !description) {
    return {
      item: null,
      problem: "The YouTube package reply was missing a titles array or a description.",
    };
  }
  return { item: { titles, description } };
}

/**
 * Plain-prose derivative text (linkedin_post, x_thread, newsletter_blurb):
 * reasoning blocks and markdown fences stripped, trimmed. Empty → problem.
 */
export function parseDerivativeProse(content: string): ParseDerivativeResult<string> {
  const text = stripFences(stripThinkBlocks(content)).trim();
  return text ? { item: text } : { item: null, problem: "The reply came back empty." };
}
