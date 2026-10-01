# PostGavel

A simple AI content workspace: create **projects**, describe what each one is
about, configure **OpenRouter** (API key + which model does which task), tune
**every prompt**, and generate **long-form article ideas** — all on Cloudflare.
Status: **phases 0–6 complete** (scaffold → schema/tenancy → brief → AI config
→ prompts → idea generation → hardening). See
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Stack

- **Cloudflare Worker** (one deploy): [Hono](https://hono.dev) API + serves the SPA via Workers Static Assets.
- **D1** (SQLite) + **drizzle-orm** / drizzle-kit migrations.
- **React + Vite SPA** (`apps/web`), built to `dist/` and served by the Worker.
- **OpenRouter** called directly with `fetch` (OpenAI-compatible chat completions) — no SDK.
- API keys are encrypted at rest with **AES-256-GCM** (WebCrypto, HKDF from the `ENCRYPTION_KEY` worker secret).
- Input validation with **zod**; uniform error envelope; per-project rate limiting via a D1 fixed-window counter.

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

1. **Create a project** on `/projects`, then fill in the brief (what it's
   about, content guidelines, content types) — these feed the prompt variables.
2. **AI config** (`/projects/:id/ai-config`): paste your OpenRouter API key
   (stored encrypted, shown only as a `…last4` hint), pick a model per task,
   and use **Test connection**.
3. **Prompts** (`/projects/:id/prompts`): every prompt sent to OpenRouter is
   editable per project; `{{variables}}` are substituted from the brief.
4. **Ideas** (`/projects/:id/ideas`): pick a count, optionally a topic hint,
   generate, and manage the stored ideas.

Auth: real login is not built yet (plan §4). In dev the identity comes from the
`X-Dev-User: <email>` request header, falling back to a fixed default dev
account — so the SPA works out of the box, and different "accounts" can be
simulated with the header (e.g. via `curl -H "X-Dev-User: alice@example.com"`).

## API

Base URL: `/api`. Every error answers the uniform envelope (codes optional,
documented per route below):

```json
{ "error": "human-readable message", "code": "MachineReadableCode" }
```

Auth for all routes below: the dev actor middleware (`X-Dev-User` header or
default account). Project access = membership in `project_members`; any member
may read, editors may write, owners may share/delete ("editor+"/"owner+") —
otherwise `404` (no existence leak) / `403`.

| Method & path | Body | Codes |
|---|---|---|
| `GET /api/health` | — | — |
| `GET /api/me` | — | — |
| `GET /api/meta/tasks` | — | — |
| `GET /api/meta/openrouter-models` | — | — |
| `GET /api/projects` | — | — |
| `POST /api/projects` | `{ name }` (1–200 chars) | `ValidationError` |
| `GET /api/projects/:id` | — | — |
| `PUT /api/projects/:id` | any of `{ name, description, content_guidelines, content_types }` | `ValidationError` |
| `DELETE /api/projects/:id` | — | owner only |
| `GET /api/projects/:id/members` | — | — |
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
| `POST /api/projects/:id/ideas/generate` | optional `{ topic_hint?, count? }` (count clamped to 1–10) | `ValidationError`, `NotConfigured`, `DecryptFailed`, `InvalidKey`, `NoCredits`, `RateLimited`, `InvalidModel`, `ProviderError`, `NetworkError`, `UnknownResponse`, `GenerationFailed` |
| `GET /api/projects/:id/ideas` | — | — |
| `DELETE /api/projects/:id/ideas/:ideaId` | — | — |

Rate limits (per project, fixed 1-minute windows, D1 counter): idea generation
**5/min** (`POST …/ideas/generate`), AI config test **10/min**
(`POST …/ai-config/test`). Exceeding them returns `429` with code
`RateLimited` and a `Retry-After` header.
