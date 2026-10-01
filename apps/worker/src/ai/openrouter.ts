/**
 * Minimal OpenRouter client (OpenAI-compatible chat completions), plan §5.
 * Plain `fetch` only — no SDK, no Node APIs, Cloudflare Workers safe.
 *
 * Typed error taxonomy: every failure surfaces as an {@link OpenRouterError}
 * with a machine-readable `code` (mapped to HTTP status by the routes). Mapping
 * is deliberately conservative: unexpected bodies never crash, the provider's
 * message text is included truncated for debugging.
 */

export type OpenRouterErrorCode =
  | "InvalidKey" // 401/403: the API key was rejected
  | "NoCredits" // 402: account out of credits
  | "RateLimited" // 429: too many requests
  | "InvalidModel" // 400/404 whose body references the model id
  | "ProviderError" // any other 4xx/5xx from OpenRouter
  | "NetworkError" // fetch itself threw (DNS, TLS, connection, abort)
  | "UnknownResponse"; // 2xx but body is not the expected completion shape

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  /** Upstream HTTP status, when the error came from a response. */
  readonly status?: number;

  constructor(code: OpenRouterErrorCode, message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = status;
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type GenerateArgs = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** Adds `response_format: { type: "json_object" }` for structured output. */
  json?: boolean;
  maxTokens?: number;
};

/** Identifies PostGavel to OpenRouter (attribution/ranking headers). */
export const OPENROUTER_APP_URL = "https://postgavel.siim-liimand.workers.dev";
const OPENROUTER_TITLE = "PostGavel";
const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Provider messages are truncated before they ever reach a response/log. */
const MAX_PROVIDER_MESSAGE = 300;

export async function generateCompletion(args: GenerateArgs): Promise<string> {
  let res: Response;
  try {
    res = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_APP_URL,
        "X-Title": OPENROUTER_TITLE,
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        max_tokens: args.maxTokens,
        ...(args.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch {
    throw new OpenRouterError("NetworkError", "Could not reach OpenRouter (network error).");
  }

  const raw = await res.text().catch(() => "");
  const parsed = parseJsonSafe(raw);
  const providerMessage = extractProviderMessage(parsed) ?? flatten(raw);

  if (!res.ok) throw mapHttpError(res.status, providerMessage, raw, args.model);

  const content = extractContent(parsed);
  if (content === null) {
    throw new OpenRouterError(
      "UnknownResponse",
      "OpenRouter returned a success status but no completion content.",
      res.status,
    );
  }
  return content;
}

/** HTTP status → typed code. 400/404 only become InvalidModel when the body
 * references the model; anything else falls back to ProviderError. */
function mapHttpError(status: number, message: string | null, raw: string, model: string): OpenRouterError {
  const detail = message ? `OpenRouter said: "${message}"` : `OpenRouter returned HTTP ${status}.`;
  switch (status) {
    case 401:
    case 403:
      return new OpenRouterError("InvalidKey", `OpenRouter rejected the API key. ${detail}`, status);
    case 402:
      return new OpenRouterError("NoCredits", `The OpenRouter account has no credits. ${detail}`, status);
    case 429:
      return new OpenRouterError("RateLimited", `OpenRouter rate limit hit. ${detail}`, status);
    case 400:
    case 404:
      if (referencesModel(message, raw, model)) {
        return new OpenRouterError("InvalidModel", `Unknown or unavailable model "${model}". ${detail}`, status);
      }
      return new OpenRouterError("ProviderError", `OpenRouter request failed. ${detail}`, status);
    default:
      return new OpenRouterError("ProviderError", `OpenRouter request failed (HTTP ${status}). ${detail}`, status);
  }
}

function referencesModel(message: string | null, raw: string, model: string): boolean {
  const haystack = `${message ?? ""}\n${raw}`.toLowerCase();
  if (model && haystack.includes(model.toLowerCase())) return true;
  return /no such model|unknown model|invalid model|not a valid model|model not found|no endpoints found|no allowed providers/i.test(
    message ?? "",
  );
}

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pulls the human-readable message out of OpenRouter's error shapes:
 * `{ "error": "…" }`, `{ "error": { "message": "…" } }` or `{ "message": "…" }`. */
function extractProviderMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err.trim()) return truncate(err.trim());
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return truncate(msg.trim());
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) return truncate(message.trim());
  return null;
}

/** OpenAI-compatible `choices[0].message.content`, or null when unexpected. */
function extractContent(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/** Non-JSON bodies: collapse whitespace and truncate for the error message. */
function flatten(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? truncate(trimmed.replace(/\s+/g, " ")) : null;
}

function truncate(text: string): string {
  return text.length > MAX_PROVIDER_MESSAGE ? `${text.slice(0, MAX_PROVIDER_MESSAGE)}…` : text;
}
