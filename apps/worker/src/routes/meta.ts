import { Hono } from "hono";
import type { AppEnv } from "../auth/actor";
import { TASKS } from "../ai/tasks";
import { OPENROUTER_APP_URL } from "../ai/openrouter";

export const metaRoutes = new Hono<AppEnv>();

/**
 * GET /api/meta/tasks → the task registry. Any authenticated actor; the AI
 * config UI (and future pages) render pickers/actions from this automatically.
 */
metaRoutes.get("/tasks", (c) => c.json(TASKS));

type CatalogModel = { id: string; name: string };

// Shown only when the public OpenRouter catalog cannot be reached, so the UI
// stays usable offline. Kept deliberately small and uncontroversial.
const FALLBACK_MODELS: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini" },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic: Claude 3.5 Sonnet" },
  { id: "google/gemini-flash-1.5", name: "Google: Gemini Flash 1.5" },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Meta: Llama 3.1 70B Instruct" },
];

/**
 * GET /api/meta/openrouter-models → slimmed public catalog ({ id, name }[]).
 * Proxy for GET https://openrouter.ai/api/v1/models (no auth header needed).
 * On any upstream failure a small hardcoded fallback list is returned with
 * `stale: true`, so the UI keeps working offline. Free-text model entry in the
 * UI must always work regardless — the catalog is only a suggestion list.
 */
metaRoutes.get("/openrouter-models", async (c) => {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "HTTP-Referer": OPENROUTER_APP_URL, "X-Title": "PostGavel" },
    });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const data: unknown = await res.json().catch(() => null);
    const rows =
      data && typeof data === "object" && "data" in data
        ? (data as { data?: unknown }).data
        : null;
    if (!Array.isArray(rows)) throw new Error("unexpected catalog shape");

    const models: CatalogModel[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const { id, name } = row as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !id) continue;
      models.push({ id, name: typeof name === "string" && name ? name : id });
    }
    if (models.length === 0) throw new Error("empty catalog");
    return c.json({ models, stale: false });
  } catch {
    return c.json({ models: FALLBACK_MODELS, stale: true });
  }
});
