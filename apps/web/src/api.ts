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

export type AudienceExpertise = "beginners" | "general" | "practitioners" | "experts";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  content_guidelines: string | null;
  /** Comma-joined in D1, exposed as a string array (Phase 8). */
  content_types: string[];
  tone: string | null;
  audience_expertise: AudienceExpertise | null;
  audience_description: string | null;
  guidelines_always: string | null;
  guidelines_never: string | null;
  created_at: number;
  updated_at: number;
};

export type ProjectWithRole = Project & { role: ProjectRole };

/**
 * The full brief PUT body: every field is always sent (the UI's single Save).
 * Empty optional fields are sent as null (clears), content_types as an array.
 */
export type ProjectInput = {
  name: string;
  description: string;
  content_guidelines: string;
  content_types: string[];
  tone: string | null;
  audience_expertise: AudienceExpertise | null;
  audience_description: string | null;
  guidelines_always: string | null;
  guidelines_never: string | null;
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
  /** Set when the idea was generated scoped to an audience problem. */
  problem_id: string | null;
  /** ISO timestamp. */
  created_at: string;
  created_by: string;
};

export type GenerateIdeasInput = {
  topic_hint?: string;
  count?: number;
  /** Phase 9: scope generation to one audience problem of this project. */
  problem_id?: string;
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

// Audience problems (Phase 9): problems-first ideation. Generate, add by hand,
// select one, then scope idea generation to it.

export type ProblemSource = "ai" | "manual";

export type Problem = {
  id: string;
  title: string;
  description: string | null;
  /** Realistic search queries, separated by semicolons. */
  search_signals: string | null;
  source: ProblemSource;
  /** ISO timestamp. */
  created_at: string;
};

export type CreateProblemInput = {
  title: string;
  description?: string;
  search_signals?: string;
};

export type GenerateProblemsInput = { count?: number };

export type GenerateProblemsResult = {
  problems: Problem[];
  model: string;
  used_retry: boolean;
  prompt_warnings?: string[];
};

export function fetchProblems(projectId: string): Promise<Problem[]> {
  return fetchJson<Problem[]>(`/api/projects/${projectId}/problems`);
}

export function createProblem(
  projectId: string,
  input: CreateProblemInput,
): Promise<Problem> {
  return fetchJson<Problem>(`/api/projects/${projectId}/problems`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function generateProblems(
  projectId: string,
  input: GenerateProblemsInput = {},
): Promise<GenerateProblemsResult> {
  return fetchJson<GenerateProblemsResult>(`/api/projects/${projectId}/problems/generate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Deletes one problem (204). Ideas scoped to it stay, minus the link. */
export async function deleteProblem(projectId: string, problemId: string): Promise<void> {
  await fetchJson<null>(`/api/projects/${projectId}/problems/${encodeURIComponent(problemId)}`, {
    method: "DELETE",
  });
}

// Content pieces (Phase 10): outlines (the human-review gate) and drafts
// (written section-by-section from an approved outline).

export type PieceFormat = "article" | "video_script";

export type PieceSection = { heading: string; points: string[] };

export type Piece = {
  id: string;
  problem_id: string | null;
  idea_id: string | null;
  type: "outline" | "draft";
  format: PieceFormat;
  title: string;
  /** Markdown — the outline render, or the assembled draft. */
  body: string;
  /** Parsed structure (outlines only, null on drafts). */
  sections: PieceSection[] | null;
  /** Model that produced the content. */
  model: string | null;
  /** ISO timestamp. */
  created_at: string;
  /** Publish kit (Phase 11): nested derivatives, [] on outlines. */
  derivatives: Derivative[];
};

export function fetchPieces(projectId: string): Promise<Piece[]> {
  return fetchJson<Piece[]>(`/api/projects/${projectId}/pieces`);
}

export type GenerateOutlineInput = { idea_id: string; format: PieceFormat };

export type GenerateOutlineResult = {
  piece: Piece;
  model: string;
  used_retry: boolean;
  prompt_warnings?: string[];
};

export function createOutline(
  projectId: string,
  input: GenerateOutlineInput,
): Promise<GenerateOutlineResult> {
  return fetchJson<GenerateOutlineResult>(`/api/projects/${projectId}/pieces/outlines`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type GenerateDraftResult = { piece: Piece; model: string };

/** Writes the whole draft (one model call per outline section server-side) —
 * expect this to take a minute or two. */
export function createDraft(projectId: string, outlineId: string): Promise<GenerateDraftResult> {
  return fetchJson<GenerateDraftResult>(`/api/projects/${projectId}/pieces/drafts`, {
    method: "POST",
    body: JSON.stringify({ outline_id: outlineId }),
  });
}

/** Deletes one piece (204). */
export async function deletePiece(projectId: string, pieceId: string): Promise<void> {
  await fetchJson<null>(`/api/projects/${projectId}/pieces/${encodeURIComponent(pieceId)}`, {
    method: "DELETE",
  });
}

// Publish kit derivatives (Phase 11): publishing metadata + social
// derivatives generated from a finished draft — one cheap AI call each, upsert
// per (draft, kind) so regenerating replaces.

export type DerivativeKind =
  | "meta"
  | "linkedin_post"
  | "x_thread"
  | "newsletter_blurb"
  | "youtube_package";

/** The parsed shape of a `meta` derivative's JSON body. */
export type MetaPackage = {
  meta_title: string;
  meta_description: string;
  slug: string;
  excerpt: string;
};

/** The parsed shape of a `youtube_package` derivative's JSON body. */
export type YoutubePackage = { titles: string[]; description: string };

export type Derivative = {
  id: string;
  draft_piece_id: string;
  kind: DerivativeKind;
  /** JSON string for meta / youtube_package; plain text/markdown otherwise. */
  body: string;
  model: string | null;
  created_at: string;
  updated_at: string;
};

export type GenerateDerivativeResult = {
  derivative: Derivative;
  model: string;
  used_retry: boolean;
  prompt_warnings?: string[];
};

/** Generates (or regenerates — latest wins) one publish-kit derivative. */
export function createDerivative(
  projectId: string,
  pieceId: string,
  kind: DerivativeKind,
): Promise<GenerateDerivativeResult> {
  return fetchJson<GenerateDerivativeResult>(
    `/api/projects/${projectId}/pieces/${encodeURIComponent(pieceId)}/derivatives`,
    {
      method: "POST",
      body: JSON.stringify({ kind }),
    },
  );
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
