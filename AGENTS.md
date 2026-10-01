# AGENTS.md — Operating Rules for AI Agents

These rules apply to every AI agent working in this repository (PostGavel).

## 1) Project Manager pattern

The primary agent acts as a **project manager**. It does not do the hands-on work itself — it delegates.

- All execution work (research, codebase analysis, writing code, running shell commands, testing) is done by **subagents**.
- The project manager writes clear, self-contained task briefs for each subagent: goal, context, files involved, constraints, and expected deliverable.
- **Maximum 5 subagents running at the same time.**
- The project manager reviews subagent output, integrates results, and communicates with the user.

## 2) New sessions start with an implementation plan question

When the user starts a new session and describes a task, the agent must first ask:

> "Do you want me to write an implementation plan first?"

- If the user answers **yes**: the agent must (a) analyze the codebase and all project documents, then (b) produce an implementation plan and get user approval before any code is written.
- If the user answers **no**: proceed with the task directly.

## 3) Cloudflare operations

- All Cloudflare work (workers, pages, KV, R2, D1, secrets, deployments) is done with **`wrangler`**.
- The Cloudflare API token is located at **`/root/.cloudflare-token`**. Use it, for example, as:
  `CLOUDFLARE_API_TOKEN=$(cat /root/.cloudflare-token) wrangler <command>`
- Never commit the token or copy it into any file in the repo.

## 4) GitHub operations

- All GitHub work (issues, PRs, repos, releases) is done with the **`gh`** CLI.

## 5) Browser

The system has **Chromium (Playwright build) installed**:

- Binary: `/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` (v151.0.7922.34)
- Headless-only alternative: `/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
- This is a headless server, and agents run as root — **always pass `--no-sandbox`**.

Usage examples:

```bash
CHROME=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome

# Screenshot a page
$CHROME --headless --no-sandbox --disable-gpu \
  --screenshot=/tmp/opencode/shot.png --window-size=1280,800 https://example.com

# Dump rendered DOM
$CHROME --headless --no-sandbox --disable-gpu --dump-dom https://example.com

# Print to PDF
$CHROME --headless --no-sandbox --disable-gpu --print-to-pdf=/tmp/opencode/page.pdf https://example.com
```

Alternatively use the Playwright CLI, which resolves the same browser cache automatically:
`npx playwright screenshot --viewport-size=1280,800 https://example.com out.png`

## 6) Installing packages

- **apt packages:** require explicit user permission first. Always ask before `apt-get install`.
- **Node packages:** may be installed freely, locally (`npm install <pkg>`) or globally (`npm install -g <pkg>`) — no permission needed.

## 7) Postiz reference project

The sibling project at **`../postiz/`** (i.e. `/var/www/code.webuilder.dev/postiz/`) may be used as **inspiration** for this project (architecture, patterns, features, tooling).

- The agent has **read-only** rights there: analyze freely, never modify its files.
- It may be analyzed in two cases:
  1. The **user explicitly asks** for it, or
  2. The **agent thinks it is a good idea** — but in that case the agent must **first ask the user** for approval before analyzing it.
- Inspiration only: never copy code blindly; respect Postiz's license, and adapt patterns to this project's requirements (especially rule 8 — Cloudflare deployability).

## 8) Cloudflare deployability (hard requirement)

This project **must be deployable to Cloudflare** at all times.

- Every feature and dependency choice must be compatible with the Cloudflare runtime (Workers/Pages).
- Do not use Node-only APIs that Cloudflare Workers does not support; prefer Web-standard APIs.
- After significant changes, verify the project still builds and deploys to Cloudflare (via `wrangler`, see rule 3).
- Keep configuration (`wrangler.toml` / `wrangler.jsonc`) up to date in the repo.
