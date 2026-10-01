export class ApiError extends Error {
  status: number;
  /** Machine-readable code from the server's extended envelope, when present. */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * fetch + JSON in/out. Throws ApiError carrying the server's `error` message
 * (the API's error envelope) so pages can show it directly.
 */
export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body: fall through to the generic status handling below.
    }
  }

  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (HTTP ${res.status})`;
    const code =
      typeof data === "object" && data !== null && "code" in data && typeof data.code === "string"
        ? data.code
        : undefined;
    throw new ApiError(res.status, message, code);
  }
  return data as T;
}

// API shapes are snake_case, matching the worker's JSON.
export type ProjectRole = "owner" | "editor";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  content_guidelines: string | null;
  content_types: string | null;
  created_at: number;
  updated_at: number;
};

export type ProjectWithRole = Project & { role: ProjectRole };

export type ProjectInput = {
  name: string;
  description: string;
  content_guidelines: string;
  content_types: string;
};

// AI configuration (worker sends snake_case, matching plan §3 column names).

export type TaskDef = {
  key: string;
  label: string;
  promptKey: string;
  defaultModel: string;
};

export type AiConfigTask = {
  key: string;
  label: string;
  prompt_key: string;
  default_model: string;
  /** Effective model: stored row ?? registry default. */
  model: string;
  /** True when no stored row exists and `model` is the registry default. */
  is_default: boolean;
};

export type StoredModel = { task_type: string; model: string };

export type AiConfig = {
  configured: boolean;
  api_key_hint: string | null;
  updated_at: string | null;
  models: StoredModel[];
  tasks: AiConfigTask[];
};

export type OpenRouterModel = { id: string; name: string };

export type TestConnectionResult = {
  ok: true;
  model: string;
  latency_ms: number;
  sample: string;
};

// Prompt templates: global defaults + per-project overrides (plan §6).

export type PromptTemplate = {
  key: string;
  name: string;
  /** Variable names extracted from the default body, first-appearance order. */
  variables: string[];
  default_body: string;
  override_body: string | null;
  /** Effective body: override ?? default. */
  body: string;
  is_override: boolean;
};

export type ResolvedPrompt = {
  key: string;
  name: string;
  /** Effective body with {{variables}} substituted from the project brief. */
  text: string;
  /** Human-readable warnings, e.g. unknown variables left unresolved. */
  warnings: string[];
};

export function fetchPrompts(projectId: string): Promise<PromptTemplate[]> {
  return fetchJson<PromptTemplate[]>(`/api/projects/${projectId}/prompts`);
}

export function updatePrompt(
  projectId: string,
  key: string,
  body: string,
): Promise<PromptTemplate> {
  return fetchJson<PromptTemplate>(`/api/projects/${projectId}/prompts/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

/** Deletes the override; the prompt falls back to the global default (204). */
export async function resetPrompt(projectId: string, key: string): Promise<void> {
  await fetchJson<null>(`/api/projects/${projectId}/prompts/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export function fetchResolvedPrompts(projectId: string): Promise<ResolvedPrompt[]> {
  return fetchJson<ResolvedPrompt[]>(`/api/projects/${projectId}/prompts/resolved`);
}

// Article ideas (plan §6: stored results of idea generation).

export type ArticleIdea = {
  id: string;
  title: string;
  angle: string;
  /** ISO timestamp. */
  created_at: string;
  created_by: string;
};

export type GenerateIdeasInput = {
  topic_hint?: string;
  count?: number;
};

export type GenerateIdeasResult = {
  ideas: ArticleIdea[];
  /** Effective model the generation ran with. */
  model: string;
  /** True when the reply only parsed after the one stricter retry. */
  used_retry: boolean;
  /** Informational warnings, e.g. unknown {{variables}} left unresolved. */
  prompt_warnings?: string[];
};

export function fetchIdeas(projectId: string): Promise<ArticleIdea[]> {
  return fetchJson<ArticleIdea[]>(`/api/projects/${projectId}/ideas`);
}

export function generateIdeas(
  projectId: string,
  input: GenerateIdeasInput,
): Promise<GenerateIdeasResult> {
  return fetchJson<GenerateIdeasResult>(`/api/projects/${projectId}/ideas/generate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Deletes one idea (204). The list refetches on the page afterwards. */
export async function deleteIdea(projectId: string, ideaId: string): Promise<void> {
  await fetchJson<null>(`/api/projects/${projectId}/ideas/${encodeURIComponent(ideaId)}`, {
    method: "DELETE",
  });
}

// Authentication (plan §4/§7). The session lives in the pg_session cookie;
// same-origin fetch attaches it automatically, so no token handling here.

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

export type AuthResponse = { user: AuthUser };

export function register(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthResponse> {
  return fetchJson<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return fetchJson<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Revokes the server-side session and clears the cookie (204). */
export async function logout(): Promise<void> {
  await fetchJson<null>("/api/auth/logout", { method: "POST" });
}

/** The signed-in account; rejects with a 401 ApiError (code "Unauthorized") when signed out. */
export function me(): Promise<AuthUser> {
  return fetchJson<AuthUser>("/api/auth/me");
}

/**
 * Friendly line for auth forms: the server's typed codes map to fixed,
 * human text (plan §7); unknown codes pass the server message through, and a
 * non-ApiError (fetch itself failed) reads as a network problem.
 */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "InvalidCredentials":
        return "Wrong email or password.";
      case "EmailTaken":
        return "That email is already registered — try logging in instead.";
      case "RateLimited":
        return "Too many attempts — please wait a moment and try again.";
      case "ValidationError":
        return err.message;
      default:
        return err.message;
    }
  }
  return "Could not reach the server. Check your connection and try again.";
}
