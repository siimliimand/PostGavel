import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  fetchPrompts,
  resetPrompt,
  updatePrompt,
  type PromptTemplate,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

const MAX_BODY_LENGTH = 20_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One card per prompt template (rendered data-driven from the API list, so
 * Phase 5 can add keys without touching this page). Each card edits the
 * effective body; the immutable global default is shown for reference next to
 * an existing override.
 */
export default function PromptsPage({ id }: { id: string }) {
  const [prompts, setPrompts] = useState<PromptTemplate[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-card editing state, keyed by prompt key.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setPrompts(null);
    setNotFound(false);
    setLoadError(null);
    setDrafts({});
    setSaving({});
    setErrors({});
    setSavedKey(null);
    setResetting(null);
    fetchPrompts(id)
      .then((list) => {
        if (!active) return;
        setPrompts(list);
        setDrafts(Object.fromEntries(list.map((p) => [p.key, p.body])));
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadError(errorMessage(err));
      });
    return () => {
      active = false;
      // Clear any pending "Saved" flash on unmount / id change.
      window.clearTimeout(flashTimer.current);
    };
  }, [id]);

  const clearError = (key: string) => {
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = async (prompt: PromptTemplate) => {
    if (saving[prompt.key]) return;
    setSaving((prev) => ({ ...prev, [prompt.key]: true }));
    clearError(prompt.key);
    setSavedKey(null);
    try {
      const updated = await updatePrompt(id, prompt.key, drafts[prompt.key] ?? "");
      setPrompts((prev) => prev?.map((p) => (p.key === updated.key ? updated : p)) ?? prev);
      setSavedKey(prompt.key);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSavedKey(null), 2500);
    } catch (err: unknown) {
      setErrors((prev) => ({ ...prev, [prompt.key]: errorMessage(err) }));
    } finally {
      setSaving((prev) => ({ ...prev, [prompt.key]: false }));
    }
  };

  // Confirm-free on purpose: undo is one click away (re-save the body).
  const reset = async (prompt: PromptTemplate) => {
    if (resetting) return;
    setResetting(prompt.key);
    clearError(prompt.key);
    try {
      await resetPrompt(id, prompt.key);
      const list = await fetchPrompts(id);
      setPrompts(list);
      setDrafts((prev) => ({
        ...prev,
        ...Object.fromEntries(list.map((p) => [p.key, p.body])),
      }));
    } catch (err: unknown) {
      setErrors((prev) => ({ ...prev, [prompt.key]: errorMessage(err) }));
    } finally {
      setResetting(null);
    }
  };

  if (notFound) {
    return (
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>Prompts</h1>
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
          <h1>Prompts</h1>
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

  if (!prompts) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>Prompts</h1>
      <p className="muted">
        Every prompt sent to the AI is editable per project. Variables in{" "}
        <code>{"{{curly braces}}"}</code> are filled from the project brief at generation time;
        unknown ones are left in place and reported as a warning.
      </p>

      {prompts.map((prompt) => {
        const draft = drafts[prompt.key] ?? "";
        const overLimit = draft.length > MAX_BODY_LENGTH;
        return (
          <form
            key={prompt.key}
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void save(prompt);
            }}
          >
            <h2>
              {prompt.name}
              {prompt.is_override && <span className="modified-badge">Modified</span>}
            </h2>
            <p className="prompt-meta">
              <code className="prompt-key">{prompt.key}</code>
            </p>

            <p className="chips">
              <span className="muted">Variables:</span>
              {prompt.variables.length === 0 ? (
                <span className="muted">none</span>
              ) : (
                prompt.variables.map((variable) => (
                  <code key={variable} className="chip">
                    {`{{${variable}}}`}
                  </code>
                ))
              )}
            </p>

            <div className="field">
              <label htmlFor={`prompt-body-${prompt.key}`}>Prompt body</label>
              <textarea
                id={`prompt-body-${prompt.key}`}
                className="prompt-textarea"
                value={draft}
                onChange={(e) => {
                  const value = e.target.value;
                  setDrafts((prev) => ({ ...prev, [prompt.key]: value }));
                  setSavedKey(null);
                }}
                rows={10}
                spellCheck={false}
              />
            </div>
            <p className={`char-count${overLimit ? " over" : ""}`}>
              {draft.length.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()} characters
            </p>

            <div className="form-actions">
              <button type="submit" className="btn" disabled={saving[prompt.key] || !draft.trim() || overLimit}>
                {saving[prompt.key] ? "Saving…" : "Save"}
              </button>
              {prompt.is_override && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={resetting === prompt.key}
                  onClick={() => void reset(prompt)}
                >
                  {resetting === prompt.key ? "Resetting…" : "Reset to global default"}
                </button>
              )}
              {savedKey === prompt.key && <span className="flash">Saved</span>}
            </div>
            {errors[prompt.key] && (
              <p className="error" role="alert">
                {errors[prompt.key]}
              </p>
            )}

            {prompt.is_override ? (
              <details className="default-details">
                <summary>Global default</summary>
                <pre>{prompt.default_body}</pre>
              </details>
            ) : (
              <p className="hint">Using global default — edit above to override it for this project.</p>
            )}
          </form>
        );
      })}
    </>
  );
}
