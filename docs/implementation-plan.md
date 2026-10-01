# PostGavel — Implementation Plan

> **Status:** APPROVED & EXECUTED — Phases 0–7 are complete, deployed, and pushed.
> **Revised 2026-10-01 (b):** added **Phase 8 — Structured brief** (real DB columns for tone/audience/rules, chip-based formats UI, expanded prompt context block) after Phase 7 shipped; §3/§6/§7 updated accordingly.
> **Revised 2026-10-01:** added **Phase 7 — Authentication (email + password)** at the user's request; §1/§2/§3/§4/§6/§8 updated accordingly. Phase 7 awaits the user's go-ahead.
> **Original date:** 2026-10-01. Sources analyzed: AGENTS.md (project rules), `docs/postiz-analysis.md` (Postiz reference study), current repo state (empty scaffold, README title only).
> **Hard constraint:** the project must be **Cloudflare-deployable at every phase** (AGENTS.md rule 8).

---

## 1. Product summary

PostGavel is a **simple AI content workspace**: users (people or companies) create **projects**, describe what each project is about and what kind of content it needs, configure **OpenRouter** (API key + which model does which task), tune **all prompts**, and generate **long-form article ideas**.

Simpler than Postiz by intent: no social integrations, no scheduling engine, no payments. We borrow Postiz *concepts* (multi-tenancy, provider abstraction, config-driven behavior) but not its runtime (no Temporal, no NestJS, no native modules).

### In scope (this plan)

1. **Authentication** — email + password registration/login with D1-backed session cookies (Phase 7), built on the Phase 1 readiness layer (single `resolveActor` choke point).
2. **Multi-project, multi-account** — many projects per user/company; several accounts can access the same project.
3. **Project brief** — per-project description: what it's about, how content should be generated, what kind of content.
4. **OpenRouter config per project** — API key + model-per-task mapping, on a dedicated settings page.
5. **Article idea generation page** — generate long-form article ideas with AI.
6. **Configurable prompts** — every prompt sent to OpenRouter is editable (global defaults + per-project overrides).

### Out of scope (for now)

- Password reset / email verification (would need an email sender — none in this project), OIDC/SSO, device/session management UI beyond logout.
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
   │    ├── actor middleware   (session-cookie auth, email + password — §4)
   │    ├── /api/auth          (register / login / logout / me)
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

**Non-negotiables carried from AGENTS.md:** no Node-only APIs (`fs`, `crypto` node module, `bcrypt`), no background processes, no disk. Password hashing = **WebCrypto PBKDF2-SHA256** (native in Workers; never `bcrypt`).

---

## 3. Data model (D1)

Deliberately minimal. All access checks go through `project_members`, which makes adding companies/orgs later a non-breaking migration.

```sql
-- users: accounts. Credentials owned by this app since Phase 7 (email + password).
users             (id TEXT PK,            -- uuid
                   email TEXT UNIQUE,     -- login identity, stored lowercase
                   name TEXT,
                   password_hash TEXT NULL, -- PHC-style "pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>"
                                            -- NULL = invited placeholder, not yet registered
                   created_at INTEGER)

-- sessions: server-side session store. Only a hash of the token is stored.
sessions          (id TEXT PK,            -- SHA-256(token) hex; raw token lives only in the cookie
                   user_id TEXT -> users.id,
                   created_at INTEGER,
                   expires_at INTEGER,    -- created_at + 30 days, sliding renewal
                   last_used_at INTEGER)

-- projects: the workspace unit.
projects          (id TEXT PK,
                   owner_user_id TEXT -> users.id,
                   name TEXT,
                   description TEXT,      -- what this project is about
                   content_guidelines TEXT,-- free-form "Additional notes" escape hatch
                   content_types TEXT,     -- comma-joined list (API exchanges a string array)
                   tone TEXT,              -- voice, e.g. "Professional"; free string ≤100 (Phase 8)
                   audience_expertise TEXT,-- 'beginners'|'general'|'practitioners'|'experts' (Phase 8)
                   audience_description TEXT, -- who the content is for, ≤500 (Phase 8)
                   guidelines_always TEXT, -- must-have rules, ≤2000 (Phase 8)
                   guidelines_never TEXT,  -- exclusion rules, ≤2000 (Phase 8)
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

**Phase 7 migration (`0005`):** adds nullable `users.password_hash` and the `sessions` table. Additive only — existing rows (projects, members, ideas) are untouched.

**Phase 8 migrations (`0006` + `0007`):** `0006` (drizzle-kit) adds the five nullable brief columns to `projects`; `0007` (hand-written, pattern of `0003`) rewrites the "Project context" block of both global default templates to the full labeled list (`{{tone}}`, `{{audience_description}}`, `{{audience_expertise}}`, `{{guidelines_always}}`, `{{guidelines_never}}` alongside the existing variables). `projectPromptVariables()` in `src/ai/prompts.ts` is the single brief→variable map (null → `""`), shared by the prompts `/resolved` route and the ideas generate route.

---

## 4. Authentication (email + password — Phase 7)

The same single choke point every route goes through, now real:

```ts
// src/auth/actor.ts
type Actor = { userId: string; email: string; role: 'owner' | 'editor' | null /* project role */ };

resolveActor(req): Promise<Actor | null>
// NOW: verify the `pg_session` cookie → look up the sessions row (by SHA-256 of the
//      token) → load the user → Actor. No/invalid/expired session → 401
//      { error, code: "Unauthorized" } on every /api route except /api/health and
//      /api/auth/register|login.
// LOCAL DEV ONLY: when the DEV_AUTH=1 var is set in .dev.vars (never in production),
//      the old X-Dev-User header still resolves a user for API testing.
```

- Every API handler still receives the `Actor`; **no route trusts client-supplied user ids** (Postiz lesson: resolve identity server-side per request).
- All project queries still filter membership via `project_members` (ownership checks are data-driven, not identity-driven).

**Credentials.** `POST /api/auth/register { email, password, name? }` and `POST /api/auth/login { email, password }`. Passwords hashed with WebCrypto **PBKDF2-SHA256** — 16-byte random salt, 32-byte derived key, iteration count stored inside the hash string (`pbkdf2-sha256$<iter>$<salt>$<hash>`, PHC-style) so it can be raised later without a migration. Verification is constant-time. Login failures return one generic `InvalidCredentials` — never revealing whether the email exists.

**Sessions.** Login/register mint a 256-bit random token (`crypto.getRandomValues`), set it as an `HttpOnly; Secure; SameSite=Lax` cookie (`pg_session`, 30 days), and store only **SHA-256(token)** in D1 — a database leak must not yield usable sessions. Expiry slides: a session used in the second half of its life gets extended. `POST /api/auth/logout` deletes the row and clears the cookie; expired rows are deleted lazily on access.

**Brute force.** Login is rate-limited by reusing the Phase 6 D1 fixed-window limiter, keyed per email (e.g. 10 attempts / 5 min → 429 `RateLimited`) — a key generalization of the existing helper, not a new mechanism.

**CSRF posture.** `SameSite=Lax` cookie + every mutating call is same-origin `fetch` with `application/json` — adequate for this iteration; revisit only if cross-site embedding becomes a use case.

**Interplay with existing features (all preserved):**
- `users` rows are still created lazily: inviting an unregistered email via members creates a **passwordless placeholder**; that person claims the account by registering with that email. The members list marks such users "(invite pending)".
- Registering an email that already has a password → 400 `EmailTaken`. Registering a passwordless (placeholder) email claims it.
- What Phase 1 promised holds: this is one middleware swap + auth routes + two UI pages + migration `0005`. No changes to the project/brief/ai-config/prompts/ideas routes or their authorization.

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
| `/projects/:id` | **Project brief** | Card-based form: About (name, description), Audience & voice (tone presets + Custom…, expertise select, audience description), Rules (collapsed always/never), Formats (content-type chips + add-custom, "Additional notes" escape hatch). All fields feed the `{{variables}}` in prompts; one Save (PUT). |
| `/projects/:id/members` | Sharing | List/add/remove accounts (`email lookup`) on this project, roles owner/editor. |
| `/projects/:id/ai-config` | **AI config** | OpenRouter API key (masked, replace-not-view), and a model picker per task type (task list rendered from a registry, so future tasks appear automatically). Includes a "Test connection" button (cheap 1-token call). |
| `/projects/:id/prompts` | **Prompts** | All prompt templates for the project; each shows the global default (read-only reference) and an editable override; reset-to-default action; variables documented inline. |
| `/projects/:id/ideas` | **Idea generation** | Optional topic hint + count selector → Generate → results stored and listed (title + angle), delete, regenerate. |
| `/login`, `/register` | **Auth** (Phase 7) | Email + password forms; registering with an invited (passwordless) email claims that account. After login → `/projects`. |

Navigation: minimal top bar with project switcher, the signed-in email and a Log out button (Phase 7); API 401s (`code: "Unauthorized"`) redirect the SPA to `/login`. No component library — small hand-rolled components + plain CSS (Tailwind optional; decision at scaffold time, default: **no Tailwind, keep dependencies near zero**).

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

### Phase 7 — Authentication: email + password  *(medium)* — **added 2026-10-01, implemented**
- Migration `0005`: nullable `users.password_hash` (PHC-style string) + `sessions` table.
- `src/auth/passwords.ts` (WebCrypto PBKDF2-SHA256 hash/verify, constant-time compare) and `src/auth/sessions.ts` (mint/verify/revoke, cookie helpers).
- `resolveActor` swap: `pg_session` cookie → Actor; `X-Dev-User` honored only when `DEV_AUTH=1` (local `.dev.vars`, never in production); unauthenticated `/api` calls → 401 `code:"Unauthorized"`.
- Endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` — zod-validated; login rate-limited (10 / 5 min per email).
- UI: `/login`, `/register` pages; top bar shows account email + Log out; SPA redirects to `/login` on 401; members list marks invited-but-unregistered accounts; invited email claiming per §4.
- README auth section; deploy + Chromium smoke (register → login → share → second profile).
- **Checkpoint:** on the deployed URL with a clean browser profile: A registers, creates a project, shares it with B's email; B registers (claims the placeholder) and sees the shared project; `X-Dev-User` is ignored in production.

### Phase 8 — Structured brief  *(small-medium)* — **added 2026-10-01**
- Migration `0006` (drizzle-kit): nullable `projects.tone` (≤100), `audience_expertise` (`beginners`|`general`|`practitioners`|`experts`), `audience_description` (≤500), `guidelines_always` / `guidelines_never` (≤2000). Additive only; `content_guidelines` stays the free-form "Additional notes" escape hatch, `content_types` stays the comma-joined storage format.
- Migration `0007` (hand-written, pattern of `0003`): both global default templates' "Project context" block becomes the full labeled list — what it's about / tone of voice / audience / expertise level / additional notes / always include / never include / content types (+ topic hint on `article_ideas`). Rules/Output format sections untouched; per-project overrides keep resolving.
- Shared variable map: `projectPromptVariables(project)` in `src/ai/prompts.ts` returns all eight brief variables (null → `""`); used by BOTH the prompts `/resolved` route and the ideas generate route (request params `count`/`topic_hint` layered on top there) so the two paths cannot drift. Unknown-variable warnings unchanged.
- API: `PUT /api/projects/:id` accepts the five new fields (string-or-null-to-clear; `audience_expertise` is an enum) and takes `content_types` as an array of ≤12 strings (each ≤40 chars, deduped case-insensitively, order-preserving, stored comma-joined; `[]` clears). GET responses expose the new fields raw and `content_types` as a string array (the UI is the only consumer).
- UI: brief page rebuilt into cards — About / Audience & voice (tone select with presets + `Custom…` reveal, expertise select, audience description) / Rules (collapsed always/never) / Formats (preset chips + add-custom, case-insensitive matching so legacy `"Seo blog post"` shows as the `SEO article` chip; "Additional notes" textarea below). Save remains one PUT with all fields.
- **Checkpoint:** with brief fields set, the resolved prompts show each value on its labeled line (`Tone of voice: Professional`); cleared fields render empty after the colon; chips persist across reload; remote migrate + deploy, throwaway-project smoke, real project untouched.

---

## 8. Assumptions & open questions

| # | Assumption (default) | Override? |
|---|---|---|
| 1 | ~~No real login in this iteration — dev header selects the account.~~ Superseded by the 2026-10-01 revision: Phase 7 adds email + password auth; the dev header survives only for local dev behind `DEV_AUTH=1`. | Phase 7 |
| 2 | Tenancy = users + projects + members now; companies/orgs later is a small migration because all checks go through `project_members`. | §3 |
| 3 | Roles kept to `owner` / `editor` (no viewer/admin). | §3 |
| 4 | React SPA (no SSR) — simplest CF setup, fine for a logged-in tool. | §2 |
| 5 | One OpenRouter key **per project** (per company/user-level key can come later). | §3 |
| 6 | Idea output = title + angle rows (not full articles). | §6 |
| 7 | No Tailwind/component library — minimal hand-rolled UI. | §6 |
| 8 | Task registry starts with `idea_generation` only; structure supports `outline`, `draft`, `titles` etc. later. | §5 |

**Status note (2026-10-01 revision, (b)).** Phases 0–7 are implemented, deployed, and pushed. Phase 8 (structured brief, §7 above) is implemented and deployed from this working tree, left uncommitted for PM review.
