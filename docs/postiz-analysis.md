# Postiz — Project Analysis

> **Source:** read-only analysis of `/var/www/code.webuilder.dev/postiz` (version `v1.47.0`).
> **Date:** 2026-10-01. **Purpose:** reference/inspiration for PostGavel (see AGENTS.md rule 7).
> Postiz files were **not modified** in any way.

---

## 1. What is Postiz?

Postiz is an open-source **social media management platform** for scheduling, automating, and analyzing content across many social networks. Marketers, creators, agencies, and teams use it to plan posts on a shared calendar, publish to 28+ channels (Instagram, X, YouTube, LinkedIn, TikTok, Facebook, Threads, Pinterest, Reddit, Slack, Discord, Mastodon, Bluesky, and more — 38 provider implementations exist in code), measure performance with analytics, and collaborate with teammates who can comment on, approve, exchange, or trade posts. It is positioned as an alternative to Buffer/Hootsuite and is heavily automation-friendly: a public API, webhooks, and pre-built integrations (n8n node, Make.com app, Node SDK `@postiz/node`) let external workflow tools drive it.

The product ships in two editions with **identical core features and no feature gating**:

| Edition | Description |
|---|---|
| **Postiz Cloud** | Managed SaaS at postiz.com; subscription plans with 7-day free trial; pre-approved social OAuth apps (no need to register your own developer apps per platform). |
| **Postiz Open-source** | This repo; free under **AGPL-3.0**; self-hosted via Docker/Coolify/Railway/VPS. You supply your own Postgres/Redis/storage and your own developer apps per social platform (Meta/YouTube/TikTok approvals can take weeks). |

A distinctive recent emphasis is **AI**: AI Copilot, AI image/video generation, AI video clipping, a "Smart Agent", plus deep "agentic surfaces" — a hosted MCP server, a CLI, and official connectors for ChatGPT, Claude/Claude Code, Codex, Cursor, so AI agents can operate Postiz directly.

### Feature list

**Publishing & scheduling**
- Schedule posts to 28+ channels (14 highlighted in README; 38 provider files)
- Calendar views, cross-posting, repeated/recurring posts, post delays, sets, signatures
- Media library with uploads (local disk or Cloudflare R2), media design editor (Polotno/Canva), video/image transcoding via RunPod serverless
- RSS auto-post, "plugs" (internal & global automations), customer groups

**Analytics & growth**
- Per-channel analytics (requires own app credentials with analytics scopes on self-host)
- Trending content, popular posts, short-link integrations (Dub, Short.io, Kutt, LinkDrip)

**Teams & collaboration**
- Team members with roles, comments/approval workflows on posts
- Post marketplace — members can exchange or buy posts (Stripe + RevenueCat, credits/payouts)

**AI**
- AI Copilot (bring-your-own OpenAI keys on self-host; quotas on Cloud)
- AI images, AI videos, AI video clipping (YouTube → captioned vertical clips, Deepgram transcription)
- Smart Agent; agent stack: OpenAI SDK, LangChain/LangGraph, Mastra, CopilotKit, MCP SDK
- Agentic surfaces: MCP server (+ OAuth), AI Agents CLI, connectors for ChatGPT/Claude/Codex/Cursor

**Automation & integrations**
- Public API with hourly rate limits, webhooks per integration
- n8n custom node, Make.com app, `@postiz/node` SDK
- Newsletter integrations (Beehiiv, Listmonk), GitHub auth, generic OIDC (Authentik)

---

## 2. License

- **GNU AGPL-3.0** — full standard text in `LICENSE`; no Commons Clause or "fair code" addenda. README: *"We do not 'gate' features or limit the license."*
- **Practical implication:** AGPL's network clause means anyone modifying Postiz and offering it as a network service must release their modified source. For PostGavel: **inspiration and architectural patterns are fine; copying code wholesale would impose AGPL obligations on this project.** Write our own implementations.

---

## 3. Repository layout & tech stack

### Layout (pnpm monorepo, root package name `gitroom`)

```
postiz/
├── apps/
│   ├── backend/       postiz-backend       NestJS REST API (app API + public API)
│   ├── frontend/      postiz-frontend      Next.js (React 19) web UI, port 4200
│   ├── orchestrator/  postiz-orchestrator  Temporal worker: workflows/, activities/, signals/
│   ├── extension/     postiz-extension     Browser extension (Vite + CRXJS) for cookie-based auth
│   ├── commands/      postiz-command       NestJS CLI for admin/maintenance tasks
│   └── sdk/           @postiz/node         Published public Node.js SDK
├── libraries/                    # shared source libs, consumed via tsconfig path aliases
│   ├── helpers/                  @gitroom/helpers — auth, config, decorators, utils
│   ├── nestjs-libraries/         @gitroom/nestjs-libraries — the heart: Prisma schema (87 models),
│   │                             integrations/social (38 providers), Temporal, Redis, upload, AI…
│   └── react-shared-libraries/   @gitroom/react — shared React: form, helpers, translation
├── docker-compose.yaml           # app + postgres:17 + redis:7.2 + full Temporal stack
├── .env.example                  # ~197-line configuration reference
└── package.json                  # ROOT-ONLY dependency manifest (all deps hoisted here)
```

### Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.5.4, Node 22 (engines >=22.12), pnpm 10.6.1 (root-only `package.json`, no Nx/Turborepo) |
| Backend API | NestJS 11 (Express, Swagger, Throttler) |
| Frontend | Next.js 16.3.1, React 19, Tailwind 3 + SCSS, Mantine 5 (selective) |
| Background jobs | **Temporal.io** (NOT BullMQ — zero BullMQ references; Redis is only a KV store) |
| Database | PostgreSQL 17 + Prisma 6.5 (87 models) |
| Cache/throttle | Redis 7.2 (ioredis, throttler storage, OAuth state, analytics cache) |
| Object storage | Local disk or **Cloudflare R2** via AWS S3 SDK (only two options; no generic S3/Cloudinary) |
| Email | Resend (primary), nodemailer |
| Payments | Stripe (+ Connect), RevenueCat (mobile IAP) |
| AI | OpenAI SDK, LangChain/LangGraph, Mastra (own Postgres tables), CopilotKit, MCP SDK |
| Auth | JWT + bcrypt, OAuth (GitHub/Google/Apple/Farcater/OIDC), CASL permissions |
| Observability | Sentry, PostHog, Plausible |

---

## 4. How it works — backend architecture

### 4.1 Apps and modules

- **`apps/backend`** — NestJS HTTP API (port 3000). `ApiModule` holds the dashboard controllers (`routes/`: posts, integrations, media, analytics, auth, billing, settings, users, notifications, copilot, webhooks, autopost, clipping…). `PublicApiModule` exposes `/public/v1/*` with API-key auth. `MCP_ONLY` env strips it down to MCP controllers only.
- **`apps/orchestrator`** — the "workers" app: Temporal workers + all workflows/activities (Post, Email, Integrations, Video, Media, Clipping, Autopost).
- **`apps/commands`** — CLI cron tasks (e.g. bulk token `refresh`).
- **`libraries/nestjs-libraries/src/database/prisma/`** — repository per entity; pattern: thin `*.service.ts` over generic `PrismaRepository<'post'>`.
- **`libraries/nestjs-libraries/src/integrations/`** — the social provider abstraction (see 4.4).

### 4.2 Data model highlights (`schema.prisma`)

| Model | Role |
|---|---|
| `Organization` | **The tenant** (no separate workspace model). Holds `apiKey` (public API), Stripe `paymentId`, 1:1 `subscription`. |
| `User` | Email+password or social login; `isSuperAdmin`. |
| `UserOrganization` | Membership join table, `role: SUPERADMIN\|ADMIN\|USER`. |
| `Integration` | A connected social channel: `providerIdentifier` (maps to a provider class), `internalId` (platform account id), `token`/`refreshToken`/`tokenExpiration`, `refreshNeeded`, `postingTimes` JSON, encrypted `customInstanceDetails`. |
| `Post` | One row per message in a thread. `state: QUEUE\|PUBLISHED\|ERROR\|DRAFT`, `publishDate`, `content`, `image` (JSON media), `settings` JSON (contains `__type` = provider identifier), `group` uuid (links all rows of one composer submission), `parentPostId` (self-relation for threads/comments), `intervalInDays` (repeating posts), `creationMethod: WEB\|MCP\|API\|AUTOPOST\|CLI`. |

### 4.3 Lifecycle of a scheduled post (the core engine)

1. **API call** — `POST /posts` (`posts.controller.ts`); callers: dashboard (JWT cookie), public API (API key), MCP/agent tools. Body: `type` (`draft|schedule|now|update`), `date`, `posts[]` of `{integration.id, group, settings, value[]}`.
2. **Validation** — `PostsService` injects `settings.__type = integration.providerIdentifier`; per-provider DTO validation, `provider.checkValidity()` (media rules), `maxLength` checks server-side.
3. **Persistence** — upserts one row per `value[]` item; first item is the root, rest chained via `parentPostId`; all share a `group` uuid; `state = QUEUE`.
4. **Workflow start** — terminates any running workflow for the post, then starts **`postWorkflowV112`** (Temporal, `workflowId: post_<postId>`, task queue `main`).
5. **Durable wait** — the workflow runs `getPost` (subscription check, re-anchor interval posts), then a durable `sleep()` until `publishDate`.
6. **Pre-flight** — if `integration.refreshNeeded`/`disabled` → `ERROR` state + notification.
7. **Publish activity** — runs **on the provider's task queue**; resolves the provider via `IntegrationManager`, strips HTML per provider editor, resolves media, calls `provider.postPending()` with heartbeats.
8. **Pending handshake** — for async platforms (X/TikTok/YouTube transcoding): poll `checkPostStatus` every 20 s (max 90) → `finalizePost` when ready.
9. **Error taxonomy** — `refresh_token` → refresh activity → retry; `bad_body` → terminal; "never started" vs "outcome unknown" distinguished via heartbeat details to avoid duplicate posts. **No automatic SDK retries on publishing** (duplicate-post defense).
10. **Success** — `PUBLISHED` state, `releaseId`/`releaseURL` stored, success notification, webhooks POSTed (SSRF-safe).
11. **Post-publish** — internal plugs (decorated provider methods, e.g. X "repost if…"), global plugs (DB rows), and repeat posts (`intervalInDays` → child workflow chains forever).
12. **Safety net** — an infinite Temporal cron workflow (`RUN_CRON` instance) sweeps hourly for `QUEUE` posts whose publish time passed but have no running workflow, and re-signals them.
13. **Deletion** — soft-delete of the group + workflow termination.

### 4.4 Integration provider pattern (the key design)

- **Contract:** `SocialProvider` interface = `IAuthenticator` (`generateAuthUrl`, `authenticate`, `refreshToken`, optional `reConnect`, `analytics`) + `ISocialMediaIntegration` (`post`, optional `postPending`/`comment`) + metadata — in `social.integrations.interface.ts`.
- **Base class:** `SocialAbstract` — provides Temporal-aware typed failures (`RefreshToken`, `Disconnect`, `BadBody` as non-retryable `ApplicationFailure`), SSRF-safe fetch helpers, heartbeat details.
- **Registry:** a plain static array `socialIntegrationList` in `integration.manager.ts` (~35 instances) — no DI tokens. `IntegrationManager` resolves by identifier, extracts `@Tool`/`@Plug`/`@Rules` metadata for the AI agent.
- **Per-provider Temporal task queue:** the identifier prefix (`x`, `tiktok-business` → `tiktok`) doubles as the activity task queue → per-platform concurrency control (each provider declares `maxConcurrentJob`).
- **Adding a platform:** (1) create `social/<name>.provider.ts` extending `SocialAbstract`; (2) append to `socialIntegrationList`; (3) add env keys; queue + agent tools are auto-derived.

### 4.5 Auth & multi-tenancy

- Session: HS256 JWT in httpOnly `auth` cookie (or header); **the middleware re-resolves the user from DB on every request** — token claims are never trusted for authorization.
- Authorization: CASL policies via `@CheckPolicies` decorator + global guard, folded together with **subscription-tier limits** (channels, seats, AI credits).
- Social OAuth connect: `state`/`codeVerifier` stored in Redis; optional two-step flows for page selection (Facebook/LinkedIn); per-channel `refreshTokenWorkflow` sleeps durably until `tokenExpiration`, then refreshes.
- Public API auth: `Authorization: <org apiKey>` or `pos_…` OAuth app token — separate from the web-app JWT.

### 4.6 AI integration

- `openai.service.ts`: generate/split posts, pick video clips, generate images/slides/voice.
- LangGraph agent graph; provider actions exposed as agent tools via `@Tool` decorators; provider rules via `@Rules`.
- **MCP server** mounted at `/mcp` (+ OAuth-protected variants) — this is how Claude/ChatGPT/Cursor post through Postiz. Mastra persistence in `mastra_*` Prisma tables; CopilotKit in-app copilot.
- Credit-metered per subscription.

---

## 5. How it works — frontend & API

- **Next.js 16 App Router + React 19.** Thin server components (`force-dynamic`) wrapping `'use client'` components; virtually all data fetched client-side from REST.
- **Routes:** `/launches` (the calendar), `/agents` (AI chat), `/analytics`, `/media`, `/plugs`, `/third-party`, `/settings`, `/billing`, `/auth/*`, `/integrations/social/[provider]` (OAuth callbacks), `/oauth/authorize` (Postiz as OAuth provider), `/p/[id]` (public preview), `/modal/[style]/[platform]` (extension UI).
- **UI stack:** Mantine 5 (selective) + large hand-rolled component set; Tailwind 3 + SCSS; **SWR** for data + **zustand** for the composer store; react-hook-form; i18next (16 languages); TipTap 3 editor with mentions.
- **Calendar:** fully custom (~1,400 lines), dayjs grids + react-dnd drag-and-drop between days/times. No calendar library.
- **API routing:** no global prefix; production nginx maps `/api/` → NestJS :3000, everything else → Next :4200, replaying `auth`/`showorg`/`impersonate` cookies as headers.
- **Media pipeline:** Uppy 4 client uploads → `local` (xhr to `/media/upload-server`, multer → disk) or `cloudflare` (**R2 multipart with presigned calls proxied through the API**); optional RunPod normalization; AI image/video generation endpoints; video clipping via RunPod + Deepgram.
- **No PWA, no Electron.** Chrome extension (MV3) exists for cookie-based posting on platforms without APIs (e.g. Skool).

---

## 6. Infrastructure & deployment

### Self-hosted architecture

```
              ┌──────────────────────────────────────────────────┐
              │  postiz container (ghcr.io/gitroomhq/postiz-app) │
 browser ────► │  nginx :5000                                     │
              │   /api/     ──► :3000  NestJS backend            │
              │   /uploads/ ──► disk volume                      │
              │   /         ──► :4200  Next.js frontend          │
              │  pm2: backend + frontend + orchestrator          │
              └───────┬──────────────┬──────────────┬────────────┘
                      ▼              ▼              ▼
              postgres:17      redis:7.2      Temporal stack
              (Prisma DB)      (KV/throttle)  (server + own Postgres 16
                                               + Elasticsearch 7.17 + UI)
```

- **Single image monolith**: nginx + 3 Node processes under pm2 (`Dockerfile.dev`, `node:22-bookworm-slim`).
- **Temporal is the backbone** and needs its own heavyweight stack (Go server + Postgres + Elasticsearch).
- **State is externalized** (Postgres, Redis, Temporal, R2) — app containers are otherwise stateless.
- **Scaling knobs:** `EXCLUDE_QUEUE` (pin a provider's queue to one server), `WORKER_CONCURRENCY_DIVIDER` (split per-provider concurrency across N servers), `RUN_CRON` (exactly one instance starts the cron workflow).
- **Storage selection:** `UploadFactory` switch on `STORAGE_PROVIDER` = `local` | `cloudflare` (R2). Advanced media features are gated to R2 because they need presigned URLs.
- **CI/CD:** GitHub Actions — `build.yml` (build on push/PR), `build-containers.yml` (multi-arch amd64+arm64 images to GHCR with manifest merging). Deploy targets: Docker/Coolify/Railway/VPS.
- **Cloud vs self-host:** no `CLOUD_MODE` flag — same codebase; "cloud-ness" inferred from env presence (`STRIPE_PUBLISHABLE_KEY` enables billing UI, `RESEND_API_KEY` enforces email activation, `IS_GENERAL` toggles branding).

---

## 7. Cloudflare Workers compatibility assessment

Postiz is **inherently non-serverless**. What blocks a Workers port:

1. **Temporal worker runtime** — persistent long-poll gRPC connections, V8 isolates, infinite `while(true) sleep('1 hour')` cron workflows. Impossible on Workers.
2. **The Temporal server itself** — Go binary + Elasticsearch + own Postgres; no Workers offering.
3. **Node-only native modules** — `bcrypt`, `sharp`, `canvas`, pm2/nginx process supervision.
4. **Long-running/synchronous media work in-process** — ffmpeg paths, 2 GB uploads through multer streams (Workers CPU-time/body limits).
5. **Filesystem dependency** — `LocalStorage` uses `fs`/`mkdirSync`; Workers have no writable disk.
6. **Stateful Express/NestJS server** — cookies/compression/global guards, raw-TCP Postgres (ioredis, Prisma engine binary doesn't run on Workers; would need Driver Adapters/Accelerate + Hyperdrive).
7. **Process model** — Workers are request-scoped; no background processes (would need Durable Objects/Queues/Cron Triggers as replacements).

**Realistic Cloudflare mapping** (if one were to re-implement the concept):

| Postiz component | Cloudflare equivalent |
|---|---|
| R2 storage | already R2 ✅ |
| PostgreSQL + Prisma | D1 / Neon via Hyperdrive + Prisma Driver Adapters |
| Redis KV/throttle | Workers KV / Durable Objects / Upstash |
| Temporal workflows | **Cloudflare Workflows** (durable execution) + Queues + Cron Triggers |
| NestJS API | Workers (Hono/itty-router or Workers-compatible NestJS alternatives) |
| Next.js frontend | Workers/Pages via OpenNext |
| Local disk uploads | R2 direct uploads (presigned) |

I.e., **an architecture change, not a port** — the concepts (provider pattern, durable post workflow, pending handshakes, duplicate-publish defense) transfer; the runtime does not.

---

## 8. Lessons worth borrowing for PostGavel

1. **Provider abstraction** — one interface + abstract base class (typed failure taxonomy: refresh vs disconnect vs bad body) + a static registry; per-provider concurrency queues.
2. **Durable post lifecycle** — a workflow that sleeps until publish time, with explicit pending/resume handshakes for async platform APIs and hard duplicate-publish defense.
3. **Scheduled-post safety net** — a periodic sweep that rescues posts whose workflow died.
4. **Thread = multiple rows sharing a group uuid** with self-relation `parentPostId` — simple and flexible.
5. **Never trust JWT claims** — resolve the user/org from DB per request; fold subscription limits into authorization.
6. **Env-presence-driven editions** — no cloud/self-host code fork; features switch on configured credentials.
7. **R2 direct multipart uploads** presigned via the API — a proven pattern for serverless media.
8. **Anti-lessons for a Cloudflare-native project:** Temporal, native modules, disk filesystems, long-running workers, and 2 GB in-process uploads are exactly what PostGavel must avoid by design (AGENTS.md rule 8).
