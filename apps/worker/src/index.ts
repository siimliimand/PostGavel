import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "postgavel", time: new Date().toISOString() }),
);

app.get("/api/hello", (c) => c.json({ message: "Hello from PostGavel worker" }));

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
