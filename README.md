# PostGavel

A simple AI content workspace: create **projects**, describe what each one is
about, configure **OpenRouter** (API key + which model does which task), tune
**every prompt**, and run the content pipeline — audience **problems** →
long-form **article ideas** → reviewable **outlines** → full **drafts**
(article or video script, written section by section) → a **publish kit** per
draft (meta package, LinkedIn post, X thread, newsletter blurb, YouTube
package) — all on Cloudflare.
Status: **phases 0–11 complete** (scaffold → schema/tenancy → brief → AI config
→ prompts → idea generation → hardening → email + password authentication →
structured brief → problems-first ideation → outline → draft pipeline →
publish kit).
See [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Stack

- **Cloudflare Worker** (one deploy): [Hono](https://hono.dev) API + serves the SPA via Workers Static Assets.
- **D1** (SQLite) + **drizzle-orm** / drizzle-kit migrations.
- **React + Vite SPA** (`apps/web`), built to `dist/` and served by the Worker.
- **OpenRouter** called directly with `fetch` (OpenAI-compatible chat completions) — no SDK.
- API keys are encrypted at rest with **AES-256-GCM** (WebCrypto, HKDF from the `ENCRYPTION_KEY` worker secret).
- Input validation with **zod**; uniform error envelope; rate limiting (per project / per email) via D1 fixed-window counters.

## Layout

- `apps/worker` — Hono API, wrangler config, drizzle schema + migrations (`drizzle/`).
- `apps/web` — Vite + React SPA.
- `docs/implementation-plan.md` — the approved plan (phases, data model, design decisions).

## Prerequisites

- Node **≥ 22** and [pnpm](https://pnpm.io)
- A Cloudflare account (only needed for deploy; local dev runs fully offline)

## Development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# then edit apps/worker/.dev.vars and set your own key:
#   openssl rand -base64 32
pnpm db:migrate        # apply migrations to the local D1 (miniflare)
pnpm dev               # builds the SPA, then wrangler dev on http://localhost:8787
```

Open http://localhost:8787 — the Worker serves the SPA at `/` and the API under
`/api/*` (health check: `GET /api/health`).

After editing `apps/worker/src/db/schema.ts`, regenerate SQL migrations:

```bash
pnpm db:generate       # drizzle-kit: writes the next apps/worker/drizzle/000N_*.sql
pnpm db:migrate        # apply locally
```

## Deploy

One Cloudflare Worker + one D1 database, both managed with `wrangler`.

```bash
# 1. Authenticate (either interactive login or an API token):
wrangler login
#    or: export CLOUDFLARE_API_TOKEN=…

# 2. (New account only) create the D1 database and put its id in
#    apps/worker/wrangler.jsonc under d1_databases[0].database_id:
wrangler d1 create postgavel

# 3. Apply migrations to the remote D1 database:
pnpm db:migrate:remote

# 4. Set the encryption secret used to wrap per-project API keys:
wrangler secret put ENCRYPTION_KEY     # paste: openssl rand -base64 32

# 5. Build and deploy (typecheck + SPA build + wrangler deploy):
pnpm deploy
```

First-run checklist: D1 created and `database_id` set (step 2) → migrations
applied (step 3) → `ENCRYPTION_KEY` secret set (step 4). Changing
`ENCRYPTION_KEY` later invalidates stored API keys — save them again.

## Using the app

1. **Create a project** on `/projects`, then fill in the brief. It is
   structured: **About** (name + what it's about), **Audience & voice** (tone
   presets or a custom tone, audience expertise level, audience description),
   **Rules** (always/never include), and **Formats** — content-type chips
   (Blog post, SEO article, Newsletter, … or add your own, up to 12) plus a
   free-form "Additional notes" field. Everything here is injected into the
   prompt variables (`Tone of voice: Professional`, `Always include: …`).
2. **AI config** (`/projects/:id/ai-config`): paste your OpenRouter API key
   (stored encrypted, shown only as a `…last4` hint), pick a model per task,
   and use **Test connection**.
3. **Prompts** (`/projects/:id/prompts`): every prompt sent to OpenRouter is
   editable per project; `{{variables}}` are substituted from the brief.
4. **Problems** (top of `/projects/:id/ideas`): generate concrete audience
   problems from the brief (or add one manually), then **click a problem to
   select it** — idea generation is then scoped to it (the selection survives
   a reload; click again or "Clear selection" to go unscoped).
5. **Ideas** (`/projects/:id/ideas`): pick a count, optionally a topic hint,
   generate, and manage the stored ideas. Ideas generated for a selected
   problem keep a small problem tag.
6. **Content** (`/projects/:id/content`) — the outline → draft pipeline:

   1. On an idea card, pick **Outline article** or **Outline video** (one AI
      call) — the outline lands on the Content page.
   2. Review the outline: expand its structure (section/segment headings and
      the points each must cover). This is the human-review gate — delete and
      regenerate anything you don't like.
   3. **Write draft**: the draft is written **section by section**, one model
      call per outline section, each seeing the full outline plus what was
      already written (for continuity). This can take a minute or two; if any
      section fails, nothing partial is stored. The finished draft appears in
      the Drafts group with a word count, a rendered markdown preview, and a
      **Copy markdown** button.

   Both outline and draft prompts always include the project brief and, when
   the idea was scoped to a problem, that problem's context.

7. **Publish kit** (on every draft card, Phase 11): expand **Publish kit** on
   a finished draft and generate repurposed outputs from it — one cheap AI
   call each, grounded in the draft plus the project brief:

   - **Article drafts**: **Meta package** (meta title ≤60, meta description
     ≤155, slug, excerpt — label/value rows, copy per field), **LinkedIn
     post** (hook-first, ~1,200 characters, ≤3 hashtags), **X thread** (5–8
     numbered tweets, ≤280 characters each), **Newsletter blurb** (80–150
     words, one `[read the full post]` call to action).
   - **Video drafts**: **YouTube package** — 3 title options plus a
     description with a chapter list derived from the script's segments.

   Generated derivatives render as text cards with **Copy** buttons and a
   small **↻ regenerate** button. Regenerating **replaces** the previous
   version (one row per draft and kind — these are cheap one-calls, latest
   wins). Deleting the draft deletes its kit.

## Authentication

Accounts are **email + password** (plan §4), with server-side sessions in D1:

- **Register** at `/register` (`POST /api/auth/register`). Registering an email
  that already has a password fails with `400 EmailTaken`; registering an email
  that was invited to a project but never registered (a *passwordless
  placeholder* user) **claims** that account — the person then sees the
  projects shared with them.
- **Login** at `/login` (`POST /api/auth/login`). Failures are one generic
  `401 InvalidCredentials` ("Wrong email or password.") whether the email is
  unknown, unclaimed, or the password is wrong. Login attempts are rate
  limited per email: **10 per 5 minutes** → `429 RateLimited` (+ `Retry-After`).
- **Sessions**: register/login set an `HttpOnly; Secure; SameSite=Lax` cookie
  (`pg_session`, 30 days). Only the **SHA-256 of the token** is stored in D1
  (`sessions` table) — a database leak yields no usable sessions. Expiry
  *slides*: a session used in the second half of its life is extended back to
  the full 30 days. `POST /api/auth/logout` revokes the row and clears the
  cookie; expired rows are deleted lazily. `GET /api/auth/me` returns the
  signed-in account.
- **Password hashing**: WebCrypto **PBKDF2-SHA256** (Workers-native, no native
  modules), 16-byte random salt, 32-byte derived key, 100 000 iterations,
  stored PHC-style as
  `pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>` — the iteration
  count lives inside the string so it can be raised without a migration.
  Verification is constant-time.
- **Every `/api/*` route except** `GET /api/health`, `POST
  /api/auth/register` and `POST /api/auth/login` requires a valid session;
  without one the API answers `401 { "error": "Please sign in to continue.",
  "code": "Unauthorized" }`. The SPA redirects accordingly (`/login` when
  signed out, `/projects` when signed in).
- **Local dev only**: with `DEV_AUTH=1` in `apps/worker/.dev.vars`, the old
  `X-Dev-User: <email>` request header (or the default dev account) still
  resolves a user, so scripted API testing stays easy. `DEV_AUTH` is
  deliberately **not** defined in `wrangler.jsonc` — production never has the
  fallback, and the header is ignored there.

## API

Base URL: `/api`. Every error answers the uniform envelope (codes optional,
documented per route below):

```json
{ "error": "human-readable message", "code": "MachineReadableCode" }
```

Auth for all routes below: a valid `pg_session` session cookie (see
[Authentication](#authentication)); `X-Dev-User` works only in local dev with
`DEV_AUTH=1`. Project access = membership in `project_members`; any member
may read, editors may write, owners may share/delete ("editor+"/"owner+") —
otherwise `404` (no existence leak) / `403`.

| Method & path | Body | Codes |
|---|---|---|
| `GET /api/health` | — | — |
| `POST /api/auth/register` | `{ email, password, name? }` | `ValidationError`, `EmailTaken` (400) |
| `POST /api/auth/login` | `{ email, password }` | `ValidationError`, `InvalidCredentials` (401), `RateLimited` |
| `POST /api/auth/logout` | — | — |
| `GET /api/auth/me` | — | `Unauthorized` |
| `GET /api/me` | — | `Unauthorized` (legacy identity alias) |
| `GET /api/meta/tasks` | — | — |
| `GET /api/meta/openrouter-models` | — | — |
| `GET /api/projects` | — | — |
| `POST /api/projects` | `{ name }` (1–200 chars) | `ValidationError` |
| `GET /api/projects/:id` | — | — |
| `PUT /api/projects/:id` | any of `{ name, description, content_guidelines, content_types[], tone, audience_expertise, audience_description, guidelines_always, guidelines_never }` (new fields: string, or null to clear; `content_types` = ≤12 strings ≤40 chars, deduped, stored comma-joined, `[]` clears; `tone` 1–100; `audience_description` ≤500; `guidelines_always`/`guidelines_never` ≤2000; `audience_expertise` = `beginners`\|`general`\|`practitioners`\|`experts`) | `ValidationError` |
| `DELETE /api/projects/:id` | — | owner only |
| `GET /api/projects/:id/members` | — | — (rows carry `registered: false` for invited, not-yet-registered emails) |
| `POST /api/projects/:id/members` | `{ email, role: "owner"\|"editor" }` | `ValidationError`; `409` already a member |
| `DELETE /api/projects/:id/members/:userId` | — | owner only; owner cannot be removed |
| `GET /api/projects/:id/ai-config` | — | — |
| `PUT /api/projects/:id/ai-config` | `{ api_key }` (≤512 chars) | `ValidationError` |
| `PUT /api/projects/:id/models` | `{ models: [{ task_type, model }] }` (≤32) | `ValidationError` |
| `POST /api/projects/:id/ai-config/test` | optional `{ model }` | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse` |
| `GET /api/projects/:id/prompts` | — | — |
| `GET /api/projects/:id/prompts/resolved` | — | — |
| `PUT /api/projects/:id/prompts/:key` | `{ body }` (1–20 000 chars) | `ValidationError`; `400` unknown key |
| `DELETE /api/projects/:id/prompts/:key` | — | `NoOverride` |
| `POST /api/projects/:id/problems/generate` | optional `{ count? }` (1–10, default 5) | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse`, `GenerationFailed` |
| `GET /api/projects/:id/problems` | — | — |
| `POST /api/projects/:id/problems` | `{ title, description?, search_signals? }` (title 1–120; description ≤2000; search_signals ≤1000) — stored with `source: "manual"` | `ValidationError` |
| `DELETE /api/projects/:id/problems/:problemId` | — | — (ideas scoped to it keep their `problem_id` cleared) |
| `POST /api/projects/:id/ideas/generate` | optional `{ topic_hint?, count?, problem_id? }` (count 1–10; `problem_id` must belong to this project, else 400 — scopes the ideas via `{{problem_context}}` and stores the link) | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse`, `GenerationFailed` |
| `GET /api/projects/:id/ideas` | — | — |
| `DELETE /api/projects/:id/ideas/:ideaId` | — | — |
| `POST /api/projects/:id/pieces/outlines` | `{ idea_id, format: "article"\|"video_script" }` — one AI call; stores an outline row (markdown body + parsed `sections`); `idea_id` must belong to this project, else 400 | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse`, `GenerationFailed` |
| `POST /api/projects/:id/pieces/drafts` | `{ outline_id }` — writes the whole draft section by section (one AI call per outline section; can take a minute or two); `outline_id` must be an outline row of this project with parsable sections, else 400; a failed section stores nothing | same typed codes as outlines |
| `GET /api/projects/:id/pieces` | — | — (newest first; outline rows carry parsed `sections`; draft rows nest their `derivatives` array — `[]` on outlines) |
| `DELETE /api/projects/:id/pieces/:pieceId` | — | — |
| `POST /api/projects/:id/pieces/:pieceId/derivatives` | `{ kind: "meta"\|"linkedin_post"\|"x_thread"\|"newsletter_blurb"\|"youtube_package" }` — one AI call from the draft + brief; upserts one row per (draft, kind), regenerate replaces; `pieceId` must be a **draft** of this project and the kind must fit its format (article → meta/linkedin_post/x_thread/newsletter_blurb, video_script → youtube_package), else 400 | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse`, `GenerationFailed` |

Rate limits (D1 fixed-window counters): per project — idea generation **5/min**
(`POST …/ideas/generate`), problem generation **5/min** (`POST
…/problems/generate`), outline creation **5/min** (`POST …/pieces/outlines`),
draft writing **3/min** — counted once per draft request, not per section
(`POST …/pieces/drafts`), derivative generation **10/min** (`POST
…/pieces/:pieceId/derivatives`), AI config test **10/min** (`POST
…/ai-config/test`); per email — login **10 per 5 min**. Exceeding them returns
`429` with code `RateLimited` and a `Retry-After` header.

Tasks and models: every generation task resolves its model per project (AI
config page), falling back to `openai/gpt-4o-mini` — idea generation,
problem generation, article outline, video outline, article draft (one call
per section), video script (one call per segment), and the publish-kit
derivatives: all five kinds (meta, LinkedIn post, X thread, newsletter blurb,
YouTube package) share the single **"Publish kit derivatives"** model picker,
since each derivative is one cheap call. Stored pieces and derivatives keep
the model that produced them in their `model` column.
