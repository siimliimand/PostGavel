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
