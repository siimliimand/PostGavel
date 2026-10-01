# PostGavel

A simple AI content workspace on Cloudflare: multi-project briefs, per-project
OpenRouter configuration, editable prompts, and long-form article idea
generation. One Cloudflare Worker serves both the API (Hono) and the React SPA
(Workers Static Assets), backed by D1 via drizzle-orm.

## Layout

- `apps/worker` — Hono API + wrangler config + drizzle migrations (D1).
- `apps/web` — Vite + React SPA, built to `apps/web/dist` and served by the Worker.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev            # builds the SPA, then `wrangler dev` on http://localhost:8787
```

Local dev uses a local D1 (miniflare) — no Cloudflare account needed.

## Database

```bash
pnpm db:generate    # generate SQL migrations from src/db/schema.ts (drizzle-kit)
pnpm db:migrate     # apply migrations to local D1
pnpm db:migrate:remote  # apply migrations to the remote D1 database
```

## Build & deploy

```bash
pnpm build          # typecheck worker + build SPA
pnpm deploy         # build + `wrangler deploy` (needs CLOUDFLARE_API_TOKEN)
```

The deployed Worker serves the SPA at `/` and the API under `/api/*`
(health check: `GET /api/health`).
