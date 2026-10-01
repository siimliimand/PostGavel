import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  deleteIdea,
  fetchIdeas,
  generateIdeas,
  type ArticleIdea,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Friendly message per typed error code; the server's own message (which
 * carries the truncated provider detail) is the secondary line.
 */
const FRIENDLY_ERRORS: Record<string, string> = {
  NotConfigured: "No OpenRouter API key configured for this project.",
  InvalidKey: "OpenRouter rejected this project's API key.",
  NoCredits: "The OpenRouter account for this project has no credits.",
  RateLimited: "Rate limited by OpenRouter — try again shortly.",
  InvalidModel: "Unknown or unavailable model.",
  ProviderError: "OpenRouter request failed — try again shortly.",
  NetworkError: "Could not reach OpenRouter (network error).",
  GenerationFailed: "The AI's reply could not be parsed into ideas — please try again.",
};

/** Codes whose fix lives on the AI config page get a direct link there. */
const AI_CONFIG_CODES = new Set(["NotConfigured", "InvalidKey"]);

type GenerateError = {
  message: string;
  detail: string | null;
  configLink: boolean;
};

function toGenerateError(err: unknown): GenerateError {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError && err.code && FRIENDLY_ERRORS[err.code]) {
    return {
      message: FRIENDLY_ERRORS[err.code],
      detail,
      configLink: AI_CONFIG_CODES.has(err.code),
    };
  }
  return { message: detail, detail: null, configLink: false };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function IdeasPage({ id }: { id: string }) {
  const [ideas, setIdeas] = useState<ArticleIdea[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Generate controls.
  const [count, setCount] = useState(5);
  const [topicHint, setTopicHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<GenerateError | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIdeas(null);
    setNotFound(false);
    setLoadError(null);
    setGenerateError(null);
    setSuccessNote(null);
    setWarnings([]);
    setDeleteError(null);
    fetchIdeas(id)
      .then((list) => {
        if (active) setIdeas(list);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [id]);

  const runGenerate = async (event: FormEvent) => {
    event.preventDefault();
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    setSuccessNote(null);
    setWarnings([]);
    try {
      const trimmedHint = topicHint.trim();
      const result = await generateIdeas(id, {
        count,
        ...(trimmedHint ? { topic_hint: trimmedHint } : {}),
      });
      // The list is the source of truth — refetch after storing.
      setIdeas(await fetchIdeas(id));
      let note = `Generated ${result.ideas.length} idea${result.ideas.length === 1 ? "" : "s"} with ${result.model}.`;
      if (result.used_retry) {
        note += " The reply needed one stricter retry before it could be parsed.";
      }
      setSuccessNote(note);
      setWarnings(result.prompt_warnings ?? []);
    } catch (err: unknown) {
      setGenerateError(toGenerateError(err));
    } finally {
      setGenerating(false);
    }
  };

  const remove = async (idea: ArticleIdea) => {
    if (deleting) return;
    if (!window.confirm(`Delete the idea "${idea.title}"?`)) return;
    setDeleting(idea.id);
    setDeleteError(null);
    try {
      await deleteIdea(id, idea.id);
      setIdeas((prev) => prev?.filter((row) => row.id !== idea.id) ?? prev);
    } catch (err: unknown) {
      // A 404 just means it is already gone — drop it locally to resync.
      if (err instanceof ApiError && err.status === 404) {
        setIdeas((prev) => prev?.filter((row) => row.id !== idea.id) ?? prev);
      } else {
        setDeleteError(errorMessage(err));
      }
    } finally {
      setDeleting(null);
    }
  };

  if (notFound) {
    return (
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>Ideas</h1>
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
          <h1>Ideas</h1>
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

  if (!ideas) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>Ideas</h1>
      <p className="muted">
        Generate long-form article ideas from the project brief, using this project's configured
        model and prompts. Everything you generate is stored below.
      </p>

      <form className="card" onSubmit={(e) => void runGenerate(e)}>
        <h2>Generate ideas</h2>
        <div className="field">
          <label htmlFor="idea-count">How many</label>
          <select
            id="idea-count"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {COUNT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="idea-topic-hint">Topic hint</label>
          <input
            id="idea-topic-hint"
            type="text"
            value={topicHint}
            onChange={(e) => setTopicHint(e.target.value)}
            placeholder="Optional — steer the topics"
            maxLength={500}
            autoComplete="off"
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn" disabled={generating}>
            {generating ? "Generating… can take up to a minute" : "Generate"}
          </button>
        </div>
        {successNote && (
          <div className="result-note ok" role="status">
            {successNote}
            {warnings.map((warning) => (
              <span key={warning} className="warning-line">
                {warning}
              </span>
            ))}
          </div>
        )}
        {generateError && (
          <div className="error" role="alert">
            <strong>{generateError.message}</strong>
            {generateError.detail && <div className="error-detail">{generateError.detail}</div>}
            {generateError.configLink && (
              <div className="error-detail">
                <Link href={`/projects/${id}/ai-config`}>Open the AI config</Link>
              </div>
            )}
          </div>
        )}
      </form>

      <section>
        <h2>
          Saved ideas{ideas.length > 0 && <span className="muted"> ({ideas.length})</span>}
        </h2>
        {deleteError && (
          <p className="error" role="alert">
            {deleteError}
          </p>
        )}
        {ideas.length === 0 ? (
          <p className="empty">No ideas yet — configure AI and generate your first set.</p>
        ) : (
          <ul className="idea-list">
            {ideas.map((idea) => (
              <li key={idea.id} className="idea-card">
                <h3 className="idea-title">{idea.title}</h3>
                <p className="idea-angle">{idea.angle}</p>
                <div className="idea-meta">
                  <span>Created {new Date(idea.created_at).toLocaleDateString()}</span>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={deleting === idea.id}
                    onClick={() => void remove(idea)}
                  >
                    {deleting === idea.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
