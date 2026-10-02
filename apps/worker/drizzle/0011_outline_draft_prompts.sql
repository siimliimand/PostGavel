-- Phase 10 (outline → draft pipeline): four new global default prompts
-- (project_id IS NULL) — article_outline, video_outline, article_draft and
-- video_script. All share the exact Phase 8 context block (migration 0007)
-- plus the Phase 9 problem line; the outline/draft prompts add the common
-- suffix line "- Problem to address (may be empty): {{problem_context}}".
-- Hand-written like 0003/0007/0009: single quotes escaped by doubling, fixed
-- literal UUIDs/timestamps, INSERT OR IGNORE keeps the migration idempotent.
-- 1767225600000 = 2026-01-01T00:00:00Z (timestamps are unix milliseconds).
INSERT OR IGNORE INTO `prompt_templates` (`id`, `project_id`, `key`, `name`, `body`, `created_at`, `updated_at`) VALUES
(
  'a5156741-e20d-4f37-86b0-e23f52568014',
  NULL,
  'article_outline',
  'Article outline',
  'You are a senior content strategist and editorial lead for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}
- Problem to address (may be empty): {{problem_context}}

Article idea to outline:
- Title: {{idea_title}}
- Premise: {{idea_description}}

Task: Create a section-by-section outline for this article: 4 to 8 sections, each with 2 to 4 key points it must cover. Ground every point in the project context; name concrete data, examples, or trade-offs to include where relevant. The working title must be search-friendly: under 60 characters where possible, main keyword natural.

Output format: Respond with ONLY a JSON object (no markdown, no commentary) shaped as:
{"title": "...", "sections": [{"heading": "...", "points": ["..."]}]}
- title: working title, max 80 characters
- heading: specific section heading, max 80 characters
- points: the key points this section must cover',
  1767225600000,
  1767225600000
),
(
  '3214a03f-bfb1-4f20-8aa0-a5aa8e62b219',
  NULL,
  'video_outline',
  'Video outline',
  'You are a senior content strategist and editorial lead for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}
- Problem to address (may be empty): {{problem_context}}

Video idea to outline:
- Title: {{idea_title}}
- Premise: {{idea_description}}

Task: Create a segment-by-segment outline for a long-form video: 5 to 9 segments. The first segment is the hook (give viewers a reason to keep watching), the last is the call to action. Each segment gets a heading and 2 to 4 beats. Ground every beat in the project context; name concrete data, examples, or trade-offs to include where relevant. The working title must be search-friendly: under 60 characters where possible, main keyword natural.

Output format: Respond with ONLY a JSON object (no markdown, no commentary) shaped as:
{"title": "...", "sections": [{"heading": "...", "points": ["..."]}]}
- title: working video title, max 80 characters
- heading: segment heading, max 80 characters
- points: the beats this segment must cover',
  1767225600000,
  1767225600000
),
(
  'c3755800-f690-49dd-95c0-53c74a32c0eb',
  NULL,
  'article_draft',
  'Article draft',
  'You are a senior writer for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}
- Problem to address (may be empty): {{problem_context}}

Format note: write in markdown, follow the tone and rules above strictly.

You are writing ONE section of a longer article. Do not write the whole article.

Full outline:
{{outline_markdown}}

Section to write:
- Heading: {{section_heading}}
- Points to cover: {{section_points}}

Text already written before this section (for continuity only — never repeat it):
{{previous_sections}}

Rules:
- Start with the exact heading as a markdown H2, then the body.
- Cover every point; concrete over generic — specific examples, numbers, trade-offs.
- About 150 to 300 words unless the points demand more.
- No meta commentary; end cleanly so the next section can follow.

Output format: Respond with ONLY the markdown for this section.',
  1767225600000,
  1767225600000
),
(
  '12db35ef-7e96-4afe-88be-a59e590e8982',
  NULL,
  'video_script',
  'Video script',
  'You are a senior writer for the project described below.

Project context:
- What the project is about: {{project_description}}
- Tone of voice: {{tone}}
- Audience: {{audience_description}}
- Audience expertise level: {{audience_expertise}}
- Additional notes: {{content_guidelines}}
- Always include: {{guidelines_always}}
- Never include: {{guidelines_never}}
- Content types: {{content_types}}
- Problem to address (may be empty): {{problem_context}}

Format note: write in markdown, follow the tone and rules above strictly.

You are writing ONE segment of a longer video script. Do not write the whole script.

Full outline:
{{outline_markdown}}

Segment to write:
- Heading: {{section_heading}}
- Points to cover: {{section_points}}

Script already written before this segment (for continuity only — never repeat it):
{{previous_sections}}

Rules:
- Start with the exact heading as a markdown H2, then the body.
- Write in spoken language — short sentences, direct address.
- Include [visual: …] cues where they matter and an approximate duration in the heading line.
- Cover every point; concrete over generic — specific examples, numbers, trade-offs.
- About 120 to 250 words per segment.
- No meta commentary; end cleanly so the next segment can follow.

Output format: Respond with ONLY the markdown for this segment.',
  1767225600000,
  1767225600000
);
