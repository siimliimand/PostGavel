# PostGavel — Implementation Plan

> **Status:** DRAFT — awaiting user approval (AGENTS.md rule 2).
> **Date:** 2026-10-01
> **Sources analyzed:** AGENTS.md (project rules), `docs/postiz-analysis.md` (Postiz reference study), current repo state (empty scaffold, README title only).
> **Hard constraint:** the project must be **Cloudflare-deployable at every phase** (AGENTS.md rule 8).

---

## 1. Product summary

PostGavel is a **simple AI content workspace**: users (people or companies) create **projects**, describe what each project is about and what kind of content it needs, configure **OpenRouter** (API key + which model does which task), tune **all prompts**, and generate **long-form article ideas**.

Simpler than Postiz by intent: no social integrations, no scheduling engine, no payments. We borrow Postiz *concepts* (multi-tenancy, provider abstraction, config-driven behavior) but not its runtime (no Temporal, no NestJS, no native modules).

### In scope (this plan)

1. **Auth readiness** — architecture prepared for real authentication (implemented later).
2. **Multi-project, multi-account** — many projects per user/company; several accounts can access the same project.
3. **Project brief** — per-project description: what it's about, how content should be generated, what kind of content.
4. **OpenRouter config per project** — API key + model-per-task mapping, on a dedicated settings page.
5. **Article idea generation page** — generate long-form article ideas with AI.
6. **Configurable prompts** — every prompt sent to OpenRouter is editable (global defaults + per-project overrides).

### Out of scope (for now)

- Actual login/registration UI (auth comes later — only the readiness layer is built).
- Article *drafting* (only ideas in this iteration; the model-mapping design leaves room for it).
- Social media integrations, scheduling, publishing, teams/roles beyond read/write, billing.

---

## 2. Architecture (Cloudflare-native)

**One Cloudflare Worker, one deploy.**

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Cloudflare Workers** | Rule 8; no long-running processes by design. |
| API framework | **Hono** (TypeScript) | Workers-native, tiny, built-in middleware (CORS, JWT, validation). |
| Frontend | **React + Vite SPA**, served via **Workers Static Assets** from the same Worker | One repo, one `wrangler deploy`, no SSR complexity. |
| Database | **Cloudflare D1** (SQLite) + **drizzle-orm** + drizzle-kit migrations | Serverless SQL, no TCP/Prisma-engine problems, free tier friendly. |
| AI provider | **OpenRouter** via plain `fetch` (OpenAI-compatible `/api/v1/chat/completions`) | Works with Workers Web APIs; no SDK needed. |
| Secrets at rest | AES-GCM via **WebCrypto** (Worker secret key wraps per-project API keys) | WebCrypto is available in Workers; avoids storing plaintext keys in D1. |
| Package manager / build | pnpm (or npm), Vite build → `dist/` assets | Standard toolchain. |

```
Browser (React SPA)
   │  fetch /api/*
   ▼
Cloudflare Worker
   ├── Hono app
   │    ├── actor middleware   (auth-readiness layer; dev stub now, JWT/OIDC later)
   │    ├── /api/projects      (CRUD + brief)
   │    ├── /api/projects/:id/ai-config
   │    ├── /api/projects/:id/prompts
   │    ├── /api/projects/:id/ideas     (generate + list + delete)
   │    └── /api/projects/:id/members   (share project with other accounts)
   ├── D1 binding (drizzle)
   └── Static assets (SPA)
         │
         └── fetch https://openrouter.ai/api/v1/...  (server-side only, key never leaves the Worker)
```

**Non-negotiables carried from AGENTS.md:** no Node-only APIs (`fs`, `crypto` node module, `bcrypt`), no background processes, no disk. Password hashing later = WebCrypto PBKDF2 or a Workers-compatible library (never `bcrypt`).

---

## 3. Data model (D1)

Deliberately minimal. All access checks go through `project_members`, which makes adding companies/orgs later a non-breaking migration.

```sql
-- users: accounts. Auth-ready: created lazily; a real auth provider owns credentials later.
users             (id TEXT PK,            -- uuid
                   email TEXT UNIQUE,     -- unique identity even before real auth
                   name TEXT,
                   created_at INTEGER)

-- projects: the workspace unit.
projects          (id TEXT PK,
                   owner_user_id TEXT -> users.id,
                   name TEXT,
                   description TEXT,      -- what this project is about
                   content_guidelines TEXT,-- how content should be generated (tone, rules)
                   content_types TEXT,     -- what kind of content (e.g. "SEO blog posts, newsletters")
                   created_at INTEGER, updated_at INTEGER)

-- sharing: multiple accounts on one project. Role: 'owner' | 'editor'.
project_members   (project_id TEXT -> projects.id,
                   user_id   TEXT -> users.id,
                   role      TEXT,
                   UNIQUE(project_id, user_id))

-- OpenRouter configuration, one per project.
project_ai_config (project_id TEXT PK -> projects.id,
                   api_key_encrypted TEXT,    -- AES-GCM, wrapped with WORKER secret
                   api_key_hint TEXT,         -- last 4 chars for UI display
                   updated_at INTEGER)

-- which model does which task. One row per task type.
project_models    (project_id TEXT -> projects.id,
                   task_type TEXT,            -- 'idea_generation' | (future: 'outline','draft','titles',...)
                   model TEXT,                -- OpenRouter model id, e.g. 'openai/gpt-4o-mini'
                   UNIQUE(project_id, task_type))

-- prompt templates. Global defaults seeded; per-project rows override by key.
prompt_templates  (id TEXT PK,
                   project_id TEXT NULL -> projects.id,  -- NULL = global default
                   key TEXT,                  -- 'article_ideas'
                   name TEXT,                 -- human label shown in UI
                   body TEXT,                 -- the prompt text with {{variables}}
                   UNIQUE(project_id, key))   -- note: NULL project_id needs partial-index handling in SQLite

-- generated output of this iteration.
article_ideas     (id TEXT PK,
                   project_id TEXT -> projects.id,
                   title TEXT,
                   angle TEXT,               -- short description of the idea
                   created_at INTEGER,
                   created_by TEXT -> users.id)
```

**Seed data (migration):** global `prompt_templates` rows for every task type, with `{{project_description}}`, `{{content_guidelines}}`, `{{content_types}}`, `{{count}}`, `{{topic_hint}}` variables — so the product works out of the box and users only *edit*, never author from scratch.

---

## 4. Auth readiness design (auth implemented later)

A single choke point every route goes through:

```ts
// src/auth/actor.ts
type Actor = { userId: string; email: string; role: 'owner' | 'editor' | null /* project role */ };

resolveActor(req): Promise<Actor | null>
// NOW (dev mode): reads X-Dev-User header or returns/creates a fixed dev user → Actor.
// LATER: verify session cookie / JWT (Hono middleware, WebCrypto HMAC) or OIDC; same interface.
```

- Every API handler receives the `Actor`; **no route trusts client-supplied user ids** (Postiz lesson: resolve identity server-side per request).
- All project queries filter membership via `project_members` (ownership checks are data-driven, not identity-driven) — so whatever auth lands later, authorization logic is already correct.
- `users` rows are created on first sight (dev stub now; login later upserts).
- Adding real auth later = swap one file + registration/login routes. No schema or route changes.

---

## 5. OpenRouter integration design

```ts
// src/ai/openrouter.ts
generateCompletion({ apiKey, model, messages, json?: boolean }): Promise<string>
// POST https://openrouter.ai/api/v1/chat/completions
// headers: Authorization: Bearer <decrypted project key>, HTTP-Referer, X-Title
// runtime errors mapped to typed failures: 401 → InvalidKey, 402 → NoCredits,
// 429 → RateLimited, model missing → InvalidModel (Postiz lesson: typed error taxonomy)
```

- **Model-per-task resolution:** task type → `project_models` row → fallback to a sensible default (`openai/gpt-4o-mini`) if unset.
- **Prompt assembly:** `prompt_templates` body → substitute `{{variables}}` from the project brief + request params → messages array. The system prompt template itself is a configurable row (`system` key), also editable.
- Structured output: idea generation requests JSON (`response_format: { type: 'json_object' }` where the model supports it) and the Worker parses/validates before persisting; on parse failure, retry once with a stricter instruction.
- The API key exists only inside the Worker process (decrypted per request, never sent to the browser, never logged; UI shows `api_key_hint`).

---

## 6. UI pages (React SPA)

| Route | Page | Content |
|---|---|---|
| `/projects` | Projects list | All projects the actor can access (own + shared), create new. |
| `/projects/:id` | **Project brief** | Editable: name, *what this project is about*, *how content should be generated*, *what kind of content*. These feed the `{{variables}}` in prompts. |
| `/projects/:id/members` | Sharing | List/add/remove accounts (`email lookup`) on this project, roles owner/editor. |
| `/projects/:id/ai-config` | **AI config** | OpenRouter API key (masked, replace-not-view), and a model picker per task type (task list rendered from a registry, so future tasks appear automatically). Includes a "Test connection" button (cheap 1-token call). |
| `/projects/:id/prompts` | **Prompts** | All prompt templates for the project; each shows the global default (read-only reference) and an editable override; reset-to-default action; variables documented inline. |
| `/projects/:id/ideas` | **Idea generation** | Optional topic hint + count selector → Generate → results stored and listed (title + angle), delete, regenerate. |

Navigation: minimal top bar with project switcher. No component library — small hand-rolled components + plain CSS (Tailwind optional; decision at scaffold time, default: **no Tailwind, keep dependencies near zero**).

---

## 7. Implementation phases

Each phase ends deployable and demonstrable (rule 8). Estimated sizes are for orientation, not promises.

### Phase 0 — Scaffold & pipeline  *(small)*
- pnpm workspace: `apps/worker` (Hono + API + serves `dist/`), `apps/web` (Vite React SPA).
- `wrangler.jsonc` with D1 binding + Static Assets config; `wrangler types`.
- drizzle-kit + initial empty migration; `pnpm dev` (local D1) and `pnpm deploy` scripts.
- CI-able build; first `wrangler deploy` to prove rule 8 from day one.
- **Checkpoint:** "Hello" page served from the Worker with an `/api/health` route.

### Phase 1 — Schema, tenancy, auth stub  *(small-medium)*
- Full schema from §3 + seed migration (global prompts, defaults).
- `actor.ts` middleware (dev stub) + membership-check helpers.
- CRUD: projects, members.
- **Checkpoint:** create project via API, add a second dev account as member, both see it.

### Phase 2 — Project brief page  *(small)*
- `PUT /api/projects/:id` for the three brief fields; brief page UI.
- **Checkpoint:** brief text persists and is returned by the API.

### Phase 3 — OpenRouter config  *(medium)*
- WebCrypto encrypt/decrypt helper (`ENCRYPTION_KEY` worker secret); `project_ai_config` + `project_models` endpoints.
- AI config page: key entry (masked), model pickers, test-connection.
- `src/ai/openrouter.ts` with typed errors.
- **Checkpoint:** store a real key, run test call, see typed error with a bad key.

### Phase 4 — Prompt system  *(small-medium)*
- Prompt CRUD endpoints (per-project overrides over global defaults).
- Prompt page UI; variable substitution engine (tiny `{{var}}` replacer with strict unknown-variable warning).
- **Checkpoint:** edit `article_ideas` prompt per project; API returns resolved prompt.

### Phase 5 — Idea generation page  *(medium)*
- `POST /api/projects/:id/ideas/generate` → resolve key+model+prompt → OpenRouter call → parse → store rows.
- Ideas page UI (generate, list, delete); friendly error surfaces (InvalidKey, NoCredits…).
- **Checkpoint:** end-to-end — brief → configured model → edited prompt → real ideas stored in D1.

### Phase 6 — Hardening & deploy  *(small)*
- Input validation everywhere (zod), error envelope format, basic rate limit per project (D1 counter or Workers rate limiting binding).
- README update; final `wrangler deploy` + smoke test via system Chromium (`--dump-dom` / screenshot, AGENTS.md rule 5).
- **Checkpoint:** deployed URL usable end-to-end; deploy step documented in README.

---

## 8. Assumptions & open questions

| # | Assumption (default) | Override? |
|---|---|---|
| 1 | No real login in this iteration — dev header selects the account. | Phase 1 |
| 2 | Tenancy = users + projects + members now; companies/orgs later is a small migration because all checks go through `project_members`. | §3 |
| 3 | Roles kept to `owner` / `editor` (no viewer/admin). | §3 |
| 4 | React SPA (no SSR) — simplest CF setup, fine for a logged-in tool. | §2 |
| 5 | One OpenRouter key **per project** (per company/user-level key can come later). | §3 |
| 6 | Idea output = title + angle rows (not full articles). | §6 |
| 7 | No Tailwind/component library — minimal hand-rolled UI. | §6 |
| 8 | Task registry starts with `idea_generation` only; structure supports `outline`, `draft`, `titles` etc. later. | §5 |

**Approval requested.** On approval, Phase 0 starts and each subsequent phase proceeds in order; any override to the assumptions above should be noted before Phase 1 (schema decisions harden there).
