/**
 * Request validation (plan §7 Phase 6): one zod schema per mutating/request
 * endpoint plus `parseBody`, which replaces the hand-rolled per-route checks.
 * Every failure surfaces as the uniform error envelope with code
 * "ValidationError": `{ "error": "<path: message; …>", "code": "ValidationError" }`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { TASKS } from "../ai/tasks";
import type { AppEnv } from "../auth/actor";
import { CodedHTTPException } from "./errors";

// Field caps (documented in README's API section).
const MAX_NAME = 200;
const MAX_TEXT_FIELD = 10_000;
const MAX_EMAIL = 320;
const MAX_API_KEY = 512;
const MAX_MODEL = 256;
const MAX_MODEL_ENTRIES = 32;
const MAX_PROMPT_BODY = 20_000;
const MAX_TOPIC_HINT = 500;

/** Join zod issues as "path: message" with "; " — friendly, no zod jargon. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Read + validate a JSON body against `schema`. A missing/empty body is read
 * as `{}` so endpoints with optional bodies stay valid. Invalid JSON or a
 * schema violation throws a 400 CodedHTTPException (error envelope).
 */
export async function parseBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown = {};
  const text = await c.req.text().catch(() => "");
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CodedHTTPException(400, "Invalid JSON body", "ValidationError");
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CodedHTTPException(400, formatIssues(result.error), "ValidationError");
  }
  return result.data;
}

/** Middleware: zod-validate path params (garbage ids 400 before any DB work). */
export function validParams<S extends z.ZodType>(schema: S): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = schema.safeParse(c.req.param());
    if (!result.success) {
      throw new CodedHTTPException(400, formatIssues(result.error), "ValidationError");
    }
    await next();
  };
}

// --- Path params --------------------------------------------------------

export const projectIdParams = z.object({ projectId: z.uuid() });
export const ideaParams = z.object({ projectId: z.uuid(), ideaId: z.uuid() });

// --- Bodies ---------------------------------------------------------------

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name must be a non-empty string")
    .max(MAX_NAME, `name must be at most ${MAX_NAME} characters`),
});

export const updateProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name must be a non-empty string")
      .max(MAX_NAME, `name must be at most ${MAX_NAME} characters`)
      .optional(),
    description: z
      .string()
      .trim()
      .max(MAX_TEXT_FIELD, `description must be at most ${MAX_TEXT_FIELD} characters`)
      .optional(),
    content_guidelines: z
      .string()
      .trim()
      .max(MAX_TEXT_FIELD, `content_guidelines must be at most ${MAX_TEXT_FIELD} characters`)
      .optional(),
    content_types: z
      .string()
      .trim()
      .max(MAX_TEXT_FIELD, `content_types must be at most ${MAX_TEXT_FIELD} characters`)
      .optional(),
  })
  .refine(
    (fields) => Object.keys(fields).length > 0,
    { message: "No updatable fields provided (name, description, content_guidelines, content_types)" },
  );

export const addMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z
        .email({ message: "email must be a valid email address" })
        .max(MAX_EMAIL, `email must be at most ${MAX_EMAIL} characters`),
    ),
  role: z.enum(["owner", "editor"], { message: 'role must be "owner" or "editor"' }),
});

export const saveApiKeySchema = z.object({
  api_key: z
    .string()
    .trim()
    .min(1, "api_key must be a non-empty string")
    .max(MAX_API_KEY, `api_key must be at most ${MAX_API_KEY} characters`),
});

// The enum values derive from the task registry, so future tasks are accepted
// here automatically and the message always lists the allowed keys.
const taskTypeSchema = z.enum(TASKS.map((t) => t.key) as [string, ...string[]], {
  message: `task_type must be one of: ${TASKS.map((t) => t.key).join(", ")}`,
});

export const saveModelsSchema = z.object({
  models: z
    .array(
      z.object({
        task_type: taskTypeSchema,
        model: z
          .string()
          .trim()
          .min(1, "model must be a non-empty string")
          .max(MAX_MODEL, `model must be at most ${MAX_MODEL} characters`),
      }),
    )
    .max(MAX_MODEL_ENTRIES, `models must contain at most ${MAX_MODEL_ENTRIES} entries`),
});

export const savePromptSchema = z.object({
  // Raw length is capped (and stored raw); only emptiness is trim-checked.
  body: z
    .string()
    .max(MAX_PROMPT_BODY, `body must be at most ${MAX_PROMPT_BODY} characters`)
    .refine((value) => value.trim().length > 0, "body must be a non-empty string"),
});

export const testConfigSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1, "model must be a non-empty string when provided")
    .max(MAX_MODEL, `model must be at most ${MAX_MODEL} characters`)
    .optional(),
});

export const generateIdeasSchema = z.object({
  topic_hint: z
    .string()
    .trim()
    .max(MAX_TOPIC_HINT, `topic_hint must be at most ${MAX_TOPIC_HINT} characters`)
    .optional(),
  // count is clamped (rounded, 1..10) by the route, not rejected; only
  // non-numeric values are a validation error.
  count: z.number({ message: "count must be a number when provided" }).optional(),
});
