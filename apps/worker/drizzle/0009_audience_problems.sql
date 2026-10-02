-- Phase 9 (problems-first ideation):
-- (a) new global default prompt 'audience_problems' (project_id IS NULL) —
--     asks the model for concrete audience problems as a JSON object
--     {"problems": [...]}; its context block is copied verbatim from the
--     Phase 8 templates (migration 0007).
-- (b) the global 'article_ideas' template gains exactly one context line,
--     "- Problem to address (may be empty): {{problem_context}}", so ideas
--     can be scoped to a selected problem; everything else in the body is
--     unchanged from 0007. Hand-written like 0003/0007: single quotes escaped
--     by doubling, WHERE scoped to the global defaults only.
INSERT OR IGNORE INTO `prompt_templates` (`id`, `project_id`, `key`, `name`, `body`, `created_at`, `updated_at`) VALUES
(
  'a8f3d2c1-5e94-4b7a-9c68-2d1e4f7a3b03',
  NULL,
  'audience_problems',
  'Audience problems',
  'You are a senior content strategist and customer researcher for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}

Task: Identify {{count}} distinct, specific problems that this project''s target audience experiences in their daily work — problems this project solves or could credibly speak to. Prefer problems the audience is actively aware of and would describe in their own words. Avoid vague generic pains (for example "not enough time"); every problem must be observable, situational, and concrete.

Rules:
- Each problem must be distinct — no overlapping reformulations of the same pain.
- Ground every problem in the audience defined in the project context; if that context is thin, infer the most likely audience and stay conservative.
- Search signals must be realistic queries or phrases the audience would actually type into a search engine or an AI assistant.

Output format: Respond with ONLY a JSON object (no markdown, no commentary) shaped as:
{"problems": [{"title": "...", "description": "...", "search_signals": "..."}]}
- title: problem statement, max 120 characters
- description: 2–3 sentences — who feels it, when it bites, why it hurts
- search_signals: 2–4 realistic search queries, separated by semicolons',
  1767225600000,
  1767225600000
);

UPDATE `prompt_templates` SET `body` = 'Generate {{count}} distinct long-form article ideas for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}
- Topic hint (may be empty): {{topic_hint}}
- Problem to address (may be empty): {{problem_context}}

Rules:
- Every idea must work as a full-length article, not a news blurb or a social media post.
- Ideas must be specific to this project''s audience and goals - no generic topics that could belong to any site.
- Each idea needs a distinct angle; never rephrase the same take twice.
- If the topic hint is non-empty, all ideas must stay within it; if it is empty, choose the most valuable topics for the project yourself.

Output format (strict):
Respond with a JSON array and nothing else - no markdown fences, no preamble, no commentary. Each element of the array must be an object of exactly this shape:
{"title": string, "angle": string}
"title" is a headline-ready article title. "angle" is a 1-2 sentence description of the piece''s unique take: what it argues or reveals, and why readers should care.'
WHERE `project_id` IS NULL AND `key` = 'article_ideas';
