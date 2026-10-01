-- Phase 8: the two global default prompt templates (project_id IS NULL) get
-- the expanded "Project context" block fed by the structured brief fields
-- ({{tone}}, {{audience_description}}, {{audience_expertise}},
-- {{guidelines_always}}, {{guidelines_never}}). Everything else in each body
-- (Rules/Output format/JSON paragraphs) is unchanged from migration 0003;
-- only the context lines are replaced. Hand-written like 0003: single quotes
-- escaped by doubling, WHERE scoped to the global defaults only.
UPDATE `prompt_templates` SET `body` = 'You are a senior content strategist and editorial lead for the project described below. Your job is to plan and pitch original long-form content that serves the project''s audience and goals.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}

Ground every answer in this context. If one of the context fields is empty, work from the fields that are present and say so when a missing field materially affects your output. Think like an editor with real standards: original angles, concrete specifics, a clear point of view. Never produce generic filler or recycled listicle cliches.

When the task prompt asks for structured output, your entire reply MUST be valid JSON matching the exact shape the task prompt specifies - no markdown fences, no commentary before or after the JSON.'
WHERE `project_id` IS NULL AND `key` = 'system';

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
