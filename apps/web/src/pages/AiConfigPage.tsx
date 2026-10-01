import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  fetchJson,
  type AiConfig,
  type OpenRouterModel,
  type TestConnectionResult,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

/** Friendly message per typed OpenRouter error code; others show the server message. */
const FRIENDLY_TEST_ERRORS: Record<string, string> = {
  InvalidKey: "OpenRouter rejected this API key",
  NoCredits: "This OpenRouter account has no credits",
  RateLimited: "Rate limited — wait a few seconds and try again",
  InvalidModel: "Unknown or unavailable model",
  NotConfigured: "No API key saved for this project yet — save a key first",
};

type TestOutcome =
  | { kind: "ok"; model: string; latency_ms: number; sample: string }
  | { kind: "failed"; message: string };

function friendlyTestError(err: unknown): string {
  // HTTP 429 (this app's D1 limiter or OpenRouter itself) gets one friendly line.
  if (err instanceof ApiError && err.status === 429) {
    return FRIENDLY_TEST_ERRORS.RateLimited;
  }
  if (err instanceof ApiError && err.code && FRIENDLY_TEST_ERRORS[err.code]) {
    return FRIENDLY_TEST_ERRORS[err.code];
  }
  return err instanceof Error ? err.message : String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function AiConfigPage({ id }: { id: string }) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Model catalog for the datalist; stays empty (free text still works) on failure.
  const [catalog, setCatalog] = useState<OpenRouterModel[]>([]);

  // API key section: masked entry, replace-not-view.
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyFlash, setKeyFlash] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Model pickers, one row per task from the registry.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelsDirty, setModelsDirty] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [modelsFlash, setModelsFlash] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Test connection: always exercises the SAVED config.
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);

  useEffect(() => {
    let active = true;
    setConfig(null);
    setNotFound(false);
    setLoadError(null);
    setDrafts({});
    setModelsDirty(false);
    setShowKeyInput(false);
    setApiKey("");
    setKeyFlash(null);
    setKeyError(null);
    setModelsFlash(null);
    setModelsError(null);
    setTestOutcome(null);

    const loadConfig = fetchJson<AiConfig>(`/api/projects/${id}/ai-config`)
      .then((cfg) => {
        if (!active) return;
        setConfig(cfg);
        setShowKeyInput(!cfg.configured);
        setDrafts(Object.fromEntries(cfg.tasks.map((t) => [t.key, t.model])));
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadError(errorMessage(err));
      });

    // Catalog is optional decoration: failure just leaves the datalist empty.
    const loadCatalog = fetchJson<{ models: OpenRouterModel[]; stale: boolean }>(
      "/api/meta/openrouter-models",
    )
      .then((res) => {
        if (active) setCatalog(res.models);
      })
      .catch(() => undefined);

    void Promise.all([loadConfig, loadCatalog]);
    return () => {
      active = false;
    };
  }, [id]);

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    setKeyFlash(null);
    try {
      const updated = await fetchJson<AiConfig>(`/api/projects/${id}/ai-config`, {
        method: "PUT",
        body: JSON.stringify({ api_key: trimmed }),
      });
      setConfig(updated);
      setApiKey("");
      setShowKeyInput(false);
      setKeyFlash("API key saved");
      setTestOutcome(null);
      window.setTimeout(() => setKeyFlash(null), 2500);
    } catch (err: unknown) {
      setKeyError(errorMessage(err));
    } finally {
      setSavingKey(false);
    }
  };

  const saveModels = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || savingModels) return;
    const rows = config.tasks.map((t) => ({ task_type: t.key, model: (drafts[t.key] ?? "").trim() }));
    if (rows.some((r) => !r.model)) {
      setModelsError("Every task needs a model.");
      return;
    }
    setSavingModels(true);
    setModelsError(null);
    setModelsFlash(null);
    try {
      const updated = await fetchJson<AiConfig>(`/api/projects/${id}/models`, {
        method: "PUT",
        body: JSON.stringify({ models: rows }),
      });
      setConfig(updated);
      setDrafts(Object.fromEntries(updated.tasks.map((t) => [t.key, t.model])));
      setModelsDirty(false);
      setModelsFlash("Models saved");
      setTestOutcome(null);
      window.setTimeout(() => setModelsFlash(null), 2500);
    } catch (err: unknown) {
      setModelsError(errorMessage(err));
    } finally {
      setSavingModels(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestOutcome(null);
    try {
      const res = await fetchJson<TestConnectionResult>(`/api/projects/${id}/ai-config/test`, {
        method: "POST",
      });
      setTestOutcome({ kind: "ok", model: res.model, latency_ms: res.latency_ms, sample: res.sample });
    } catch (err: unknown) {
      setTestOutcome({ kind: "failed", message: friendlyTestError(err) });
    } finally {
      setTesting(false);
    }
  };

  if (notFound) {
    return (
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>AI configuration</h1>
          <p>This project doesn't exist or you don't have access to it.</p>
          <Link href="/projects" className="back-link">
            ← Back to projects
          </Link>
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>AI configuration</h1>
          <p className="error" role="alert">
            {loadError}
          </p>
          <Link href="/projects" className="back-link">
            ← Back to projects
          </Link>
        </div>
      </>
    );
  }

  if (!config) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>AI configuration</h1>

      <form onSubmit={saveKey} className="card">
        <h2>OpenRouter API key</h2>
        {config.configured ? (
          <p className="key-status">
            Current key <code>{config.api_key_hint}</code>
            {config.updated_at && (
              <span className="muted"> · updated {new Date(config.updated_at).toLocaleDateString()}</span>
            )}
          </p>
        ) : (
          <p className="muted">No API key saved yet.</p>
        )}

        {showKeyInput ? (
          <>
            <div className="field">
              <label htmlFor="ai-api-key">
                {config.configured ? "New API key (replaces the saved one)" : "OpenRouter API key"}
              </label>
              <input
                id="ai-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-v1-…"
                autoComplete="off"
                required
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn" disabled={savingKey || !apiKey.trim()}>
                {savingKey ? "Saving…" : "Save key"}
              </button>
              {config.configured && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowKeyInput(false);
                    setApiKey("");
                  }}
                >
                  Cancel
                </button>
              )}
              {keyFlash && <span className="flash">{keyFlash}</span>}
            </div>
          </>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => setShowKeyInput(true)}>
            Replace key
          </button>
        )}
        {keyError && (
          <p className="error" role="alert">
            {keyError}
          </p>
        )}
        <p className="hint">The key is encrypted before it is stored and can be replaced but never viewed.</p>
      </form>

      <form onSubmit={saveModels} className="card">
        <h2>Models per task</h2>
        {config.tasks.map((task) => (
          <div className="field" key={task.key}>
            <label htmlFor={`model-${task.key}`}>
              {task.label}
              {task.is_default && <span className="default-badge">default</span>}
            </label>
            <input
              id={`model-${task.key}`}
              list="openrouter-models"
              value={drafts[task.key] ?? ""}
              onChange={(e) => {
                setDrafts((prev) => ({ ...prev, [task.key]: e.target.value }));
                setModelsDirty(true);
              }}
              placeholder={task.default_model}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ))}
        <datalist id="openrouter-models">
          {catalog.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
        <div className="form-actions">
          <button type="submit" className="btn" disabled={savingModels || !modelsDirty}>
            {savingModels ? "Saving…" : "Save models"}
          </button>
          {modelsFlash && <span className="flash">{modelsFlash}</span>}
          {!modelsDirty && <span className="muted">Tasks without a saved model use their default.</span>}
        </div>
        {modelsError && (
          <p className="error" role="alert">
            {modelsError}
          </p>
        )}
      </form>

      <div className="card">
        <h2>Test connection</h2>
        <p className="muted">
          Sends a tiny request through the <strong>saved</strong> key and the saved model for idea
          generation. Save your changes before testing.
        </p>
        <button type="button" className="btn" onClick={runTest} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testOutcome?.kind === "ok" && (
          <div className="test-result ok">
            <strong>Connection works</strong> — model <code>{testOutcome.model}</code> replied in{" "}
            {testOutcome.latency_ms} ms
            <pre>{testOutcome.sample}</pre>
          </div>
        )}
        {testOutcome?.kind === "failed" && (
          <div className="test-result failed" role="alert">
            {testOutcome.message}
          </div>
        )}
      </div>
    </>
  );
}
