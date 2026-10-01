-- Global default prompt templates (project_id IS NULL): the product works out
-- of the box and users only edit these, never author from scratch (plan §3).
-- INSERT OR IGNORE keeps the migration idempotent on re-apply; fixed literal
-- UUIDs and timestamps keep the seeded rows deterministic.
-- 1767225600000 = 2026-01-01T00:00:00Z (timestamps are unix milliseconds).
INSERT OR IGNORE INTO `prompt_templates` (`id`, `project_id`, `key`, `name`, `body`, `created_at`, `updated_at`) VALUES
(
  '0f0e7e5a-6ad3-4d5f-9a10-3f2b8f4c9d01',
  NULL,
  'system',
  'System prompt',
  'You are a senior content strategist and editorial lead for the project described below. Your job is to plan and pitch original long-form content that serves the project''s audience and goals.

Project context:
- What the project is about: {{project_description}}
- Content guidelines: {{content_guidelines}}
- Content types: {{content_types}}

Ground every answer in this context. If one of the context fields is empty, work from the fields that are present and say so when a missing field materially affects your output. Think like an editor with real standards: original angles, concrete specifics, a clear point of view. Never produce generic filler or recycled listicle cliches.

When the task prompt asks for structured output, your entire reply MUST be valid JSON matching the exact shape the task prompt specifies - no markdown fences, no commentary before or after the JSON.',
  1767225600000,
  1767225600000
),
(
  '5c1a2b9e-3f47-4c68-8e72-9a04d2f6b302',
  NULL,
  'article_ideas',
  'Article idea generation',
  'Generate {{count}} distinct long-form article ideas for the project described below.

Project context:
- What the project is about: {{project_description}}
- Content guidelines: {{content_guidelines}}
- Content types: {{content_types}}
- Topic hint (may be empty): {{topic_hint}}

Rules:
- Every idea must work as a full-length article, not a news blurb or a social media post.
- Ideas must be specific to this project''s audience and goals - no generic topics that could belong to any site.
- Each idea needs a distinct angle; never rephrase the same take twice.
- If the topic hint is non-empty, all ideas must stay within it; if it is empty, choose the most valuable topics for the project yourself.

Output format (strict):
Respond with a JSON array and nothing else - no markdown fences, no preamble, no commentary. Each element of the array must be an object of exactly this shape:
{"title": string, "angle": string}
"title" is a headline-ready article title. "angle" is a 1-2 sentence description of the piece''s unique take: what it argues or reveals, and why readers should care.',
  1767225600000,
  1767225600000
);
