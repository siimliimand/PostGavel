/**
 * Runtime env as it must exist in practice. ENCRYPTION_KEY is a Worker secret
 * (set via `wrangler secret put`, `.dev.vars` in local dev). Secrets are not
 * declared in wrangler.jsonc, so `wrangler types` cannot know about them and
 * worker-configuration.d.ts (generated — never hand-edit) lacks the field.
 * Intersecting it here and using this type for the whole app makes tsc enforce
 * that every code path touching the secret assumes its presence.
 */
export type WorkerEnv = Env & { ENCRYPTION_KEY: string };
