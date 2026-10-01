export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, message);
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
