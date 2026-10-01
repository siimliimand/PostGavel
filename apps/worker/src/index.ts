import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolveActor, type AppEnv } from "./auth/actor";
import { aiConfigRoutes } from "./routes/aiConfig";
import { CodedHTTPException } from "./routes/errors";
import { ideaRoutes } from "./routes/ideas";
import { memberRoutes } from "./routes/members";
import { metaRoutes } from "./routes/meta";
import { promptRoutes } from "./routes/prompts";
import { projectRoutes } from "./routes/projects";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "postgavel", time: new Date().toISOString() }),
);

app.get("/api/hello", (c) => c.json({ message: "Hello from PostGavel worker" }));

// Every failure answers the error envelope `{ "error": "message" }` (plus
// "code" where a typed code exists: OpenRouter errors, ValidationError,
// RateLimited, …); requireProject and validation raise HTTPException, anything
// unexpected becomes a JSON 500 with no internals leaked. Extra headers on
// CodedHTTPException (Retry-After) are merged into the JSON response.
app.onError((err, c) => {
  const respond = (body: Record<string, string>, status: ContentfulStatusCode) => {
    const res = c.json(body, status);
    if (err instanceof CodedHTTPException && err.extraHeaders) {
      for (const [key, value] of Object.entries(err.extraHeaders)) res.headers.set(key, value);
    }
    return res;
  };
  if (err instanceof CodedHTTPException) {
    return respond({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof HTTPException) {
    return respond({ error: err.message }, err.status);
  }
  console.error(err);
  return respond({ error: "Internal server error" }, 500);
});

// Authenticated API. Health/hello above stay DB-free; everything in here
// resolves an actor first (dev stub, see auth/actor.ts).
const api = new Hono<AppEnv>();
api.use("*", resolveActor);

api.get("/me", (c) => {
  const { userId, email } = c.get("actor");
  return c.json({ userId, email });
});

api.route("/projects", projectRoutes);
api.route("/projects", memberRoutes);
api.route("/projects", aiConfigRoutes);
api.route("/projects", promptRoutes);
api.route("/projects", ideaRoutes);
api.route("/meta", metaRoutes);

app.route("/api", api);

// Unmatched requests: /api/* must never return SPA HTML, anything else falls
// through to the static assets layer (which serves index.html for SPA routes
// via not_found_handling: "single-page-application").
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
