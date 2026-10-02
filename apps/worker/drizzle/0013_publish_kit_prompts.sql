-- Phase 11 (publish kit): five new global default prompts (project_id IS NULL)
-- — meta_package, linkedin_post, x_thread, newsletter_blurb (article drafts)
-- and youtube_package (video drafts). All share the exact Phase 8 context
-- block (migration 0007) plus the Phase 9 problem line, followed by the
-- common draft block "Draft to work from:\n{{draft_markdown}}".
-- Hand-written like 0003/0007/0009/0011: single quotes escaped by doubling,
-- fixed literal UUIDs/timestamps, INSERT OR IGNORE keeps it idempotent.
-- 1767225600000 = 2026-01-01T00:00:00Z (timestamps are unix milliseconds),
-- same as 0011 so the prompts page lists everything alphabetically by key.
INSERT OR IGNORE INTO `prompt_templates` (`id`, `project_id`, `key`, `name`, `body`, `created_at`, `updated_at`) VALUES
(
  '2a3dad90-d663-4d69-bdc8-1e0306a18893',
  NULL,
  'meta_package',
  'Meta package',
  'You are an SEO-savvy editor for the project described below.

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

Draft to work from:
{{draft_markdown}}

Task: Produce the publishing metadata for this article. Ground everything in the draft and the project context; be honest — never promise more than the draft delivers.
- meta_title: max 60 characters, the main keyword used naturally, compelling but accurate.
- meta_description: max 155 characters, compelling and honest; makes the right reader want to click.
- slug: lowercase words separated by hyphens, max 60 characters, no filler words.
- excerpt: 1 to 2 sentences that carry the article''s core message.

Output format: Respond with ONLY a JSON object (no markdown, no commentary) shaped as:
{"meta_title": "...", "meta_description": "...", "slug": "...", "excerpt": "..."}',
  1767225600000,
  1767225600000
),
(
  '5378cc7c-87c2-40e3-913f-2c5bccd4b8be',
  NULL,
  'linkedin_post',
  'LinkedIn post',
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

Draft to work from:
{{draft_markdown}}

Task: Write a LinkedIn post that shares this article with the project''s audience.
- Open with a hook taken from the draft''s most useful or surprising point.
- Ground every claim ONLY in the draft — add nothing the draft does not say.
- Follow the project''s tone and its Never-include rules exactly; zero hype.
- Short paragraphs (1 to 3 sentences), easy to skim.
- About 1,200 characters or fewer in total.
- End with at most 3 relevant hashtags.

Output format: Respond with ONLY the post text. No markdown fences, no commentary.',
  1767225600000,
  1767225600000
),
(
  'cabdd97b-7428-4182-af27-2459ef8deffb',
  NULL,
  'x_thread',
  'X thread',
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

Draft to work from:
{{draft_markdown}}

Task: Turn this article into an X (Twitter) thread.
- 5 to 8 tweets, each max 280 characters (count links and hashtags).
- Tweet 1 is the hook; the last tweet is the takeaway or a call to read the full piece.
- Each tweet stands alone but the thread reads as one continuous argument, grounded ONLY in the draft.
- Follow the project''s tone and its Never-include rules exactly; zero hype.

Output format: Respond with ONLY the thread: one tweet per block, each starting with its number and a slash like "1/", blocks separated by a blank line. No commentary.',
  1767225600000,
  1767225600000
),
(
  'd512fbae-9676-4b9e-af05-266377396641',
  NULL,
  'newsletter_blurb',
  'Newsletter blurb',
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

Draft to work from:
{{draft_markdown}}

Task: Write a short newsletter blurb that introduces this article to the project''s subscribers.
- 80 to 150 words, personal and direct, in the project''s tone.
- Grounded ONLY in the draft; honest and specific, zero hype.
- Exactly one call to action, pointing to the full article with the placeholder link [read the full post].

Output format: Respond with ONLY the blurb text. No commentary.',
  1767225600000,
  1767225600000
),
(
  '7cabbd2f-683e-49da-9f5c-f8293cdc4742',
  NULL,
  'youtube_package',
  'YouTube package',
  'You are a YouTube-savvy editor for the project described below.

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

Draft to work from:
{{draft_markdown}}

Task: Produce the YouTube publishing package for this video script.
- titles: exactly 3 title options that balance curiosity with clarity — no clickbait, max 80 characters each.
- description: starts with a 2 to 3 sentence hook paragraph, then a chapter list derived from the script''s segments (one chapter per segment heading, plausible placeholder timestamps like 0:00), and ends with a short credits line pointing to the project.

Output format: Respond with ONLY a JSON object (no markdown, no commentary) shaped as:
{"titles": ["...", "...", "..."], "description": "..."}',
  1767225600000,
  1767225600000
);
