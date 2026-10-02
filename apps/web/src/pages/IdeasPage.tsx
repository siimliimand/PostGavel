import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ApiError,
  createProblem,
  deleteIdea,
  deleteProblem,
  fetchIdeas,
  fetchProblems,
  generateIdeas,
  generateProblems,
  type ArticleIdea,
  type Problem,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** Fixed problem batch size for now (plan Phase 9). */
const PROBLEM_COUNT = 5;

/**
 * Friendly message per typed error code; the server's own message (which
 * carries the truncated provider detail) is the secondary line.
 */
const FRIENDLY_ERRORS: Record<string, string> = {
  NotConfigured: "No OpenRouter API key configured for this project.",
  InvalidKey: "OpenRouter rejected this project's API key.",
  NoCredits: "The OpenRouter account for this project has no credits.",
  RateLimited: "Rate limited — wait a few seconds and try again.",
  InvalidModel: "Unknown or unavailable model.",
  ProviderError: "OpenRouter request failed — try again shortly.",
  NetworkError: "Could not reach OpenRouter (network error).",
  GenerationFailed: "The AI's reply could not be parsed — please try again.",
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
  // HTTP 429 (this app's D1 limiter or OpenRouter itself) gets one friendly line.
  if (err instanceof ApiError && err.status === 429) {
    return { message: FRIENDLY_ERRORS.RateLimited, detail, configLink: false };
  }
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

/** Search-signal chips: split on ";" like the prompt asks the model to. */
function signalChips(problem: Problem): string[] {
  return (problem.search_signals ?? "")
    .split(";")
    .map((signal) => signal.trim())
    .filter(Boolean);
}

function ProblemTag({ problems, problemId }: { problems: Problem[]; problemId: string | null }) {
  if (!problemId) return null;
  const problem = problems.find((row) => row.id === problemId);
  if (!problem) return null; // problem deleted since — the link is gone server-side too
  return <span className="problem-tag">Problem: {problem.title}</span>;
}

export default function IdeasPage({ id }: { id: string }) {
  const [ideas, setIdeas] = useState<ArticleIdea[] | null>(null);
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selected problem (radio feel). The selection survives a reload per project.
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);

  // Idea generate controls.
  const [count, setCount] = useState(5);
  const [topicHint, setTopicHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<GenerateError | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Problem controls (Phase 9).
  const [generatingProblems, setGeneratingProblems] = useState(false);
  const [problemError, setProblemError] = useState<GenerateError | null>(null);
  const [problemNote, setProblemNote] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualSignals, setManualSignals] = useState("");
  const [addingProblem, setAddingProblem] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingProblem, setDeletingProblem] = useState<string | null>(null);

  const selectedProblem = problems?.find((row) => row.id === selectedProblemId) ?? null;

  useEffect(() => {
    let active = true;
    setIdeas(null);
    setProblems(null);
    setNotFound(false);
    setLoadError(null);
    setGenerateError(null);
    setSuccessNote(null);
    setWarnings([]);
    setDeleteError(null);
    setProblemError(null);
    setProblemNote(null);
    setAddError(null);
    // Restore this project's problem selection after a reload.
    try {
      setSelectedProblemId(window.localStorage.getItem(selectionKey(id)));
    } catch {
      setSelectedProblemId(null);
    }
    Promise.all([fetchIdeas(id), fetchProblems(id)])
      .then(([ideaList, problemList]) => {
        if (!active) return;
        setIdeas(ideaList);
        setProblems(problemList);
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

  const selectProblem = (problemId: string | null) => {
    const next = selectedProblemId === problemId ? null : problemId;
    setSelectedProblemId(next);
    try {
      if (next) window.localStorage.setItem(selectionKey(id), next);
      else window.localStorage.removeItem(selectionKey(id));
    } catch {
      // Storage unavailable (private mode etc.) — selection is per-session then.
    }
  };

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
        ...(selectedProblem ? { problem_id: selectedProblem.id } : {}),
      });
      // The list is the source of truth — refetch after storing.
      setIdeas(await fetchIdeas(id));
      let note = `Generated ${result.ideas.length} idea${result.ideas.length === 1 ? "" : "s"} with ${result.model}.`;
      if (selectedProblem) {
        note += ` Scoped to: ${selectedProblem.title}`;
      }
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

  const runGenerateProblems = async () => {
    if (generatingProblems) return;
    setGeneratingProblems(true);
    setProblemError(null);
    setProblemNote(null);
    try {
      const result = await generateProblems(id, { count: PROBLEM_COUNT });
      setProblems(await fetchProblems(id));
      let note = `Generated ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} with ${result.model}.`;
      if (result.used_retry) {
        note += " The reply needed one stricter retry before it could be parsed.";
      }
      setProblemNote(note);
    } catch (err: unknown) {
      setProblemError(toGenerateError(err));
    } finally {
      setGeneratingProblems(false);
    }
  };

  const addManualProblem = async (event: FormEvent) => {
    event.preventDefault();
    if (addingProblem) return;
    setAddingProblem(true);
    setAddError(null);
    try {
      const title = manualTitle.trim();
      const description = manualDescription.trim();
      const signals = manualSignals.trim();
      const created = await createProblem(id, {
        title,
        ...(description ? { description } : {}),
        ...(signals ? { search_signals: signals } : {}),
      });
      setProblems((prev) => (prev ? [created, ...prev] : prev));
      setManualTitle("");
      setManualDescription("");
      setManualSignals("");
    } catch (err: unknown) {
      setAddError(errorMessage(err));
    } finally {
      setAddingProblem(false);
    }
  };

  const removeProblem = async (problem: Problem) => {
    if (deletingProblem) return;
    setDeletingProblem(problem.id);
    setProblemError(null);
    try {
      await deleteProblem(id, problem.id);
      setProblems((prev) => prev?.filter((row) => row.id !== problem.id) ?? prev);
      if (selectedProblemId === problem.id) selectProblem(null);
    } catch (err: unknown) {
      // A 404 just means it is already gone — drop it locally to resync.
      if (err instanceof ApiError && err.status === 404) {
        setProblems((prev) => prev?.filter((row) => row.id !== problem.id) ?? prev);
        if (selectedProblemId === problem.id) selectProblem(null);
      } else {
        setProblemError({ message: errorMessage(err), detail: null, configLink: false });
      }
    } finally {
      setDeletingProblem(null);
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

  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, problemId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectProblem(problemId);
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

  if (!ideas || !problems) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>Ideas</h1>
      <p className="muted">
        Start from your audience's problems, then generate long-form article ideas — scoped to a
        selected problem or straight from the project brief. Everything you generate is stored
        below.
      </p>

      <section>
        <h2>
          Audience problems
          {problems.length > 0 && <span className="muted"> ({problems.length})</span>}
          {selectedProblem && (
            <button type="button" className="clear-link" onClick={() => selectProblem(null)}>
              Clear selection
            </button>
          )}
        </h2>
        <p className="muted">
          Concrete problems your audience has that this project can credibly address. Select one to
          scope the idea generation below.
        </p>

        <div className="problem-actions">
          <button
            type="button"
            className="btn"
            disabled={generatingProblems}
            onClick={() => void runGenerateProblems()}
          >
            {generatingProblems
              ? "Generating… can take up to a minute"
              : `Generate ${PROBLEM_COUNT} problems`}
          </button>
        </div>
        {problemNote && (
          <div className="result-note ok" role="status">
            {problemNote}
          </div>
        )}
        {problemError && (
          <div className="error" role="alert">
            <strong>{problemError.message}</strong>
            {problemError.detail && <div className="error-detail">{problemError.detail}</div>}
            {problemError.configLink && (
              <div className="error-detail">
                <Link href={`/projects/${id}/ai-config`}>Open the AI config</Link>
              </div>
            )}
          </div>
        )}

        {problems.length === 0 ? (
          <p className="empty">
            No problems yet — generate a set from the brief or add one manually.
          </p>
        ) : (
          <ul className="problem-list" role="radiogroup" aria-label="Select a problem">
            {problems.map((problem) => {
              const selected = problem.id === selectedProblemId;
              return (
                <li key={problem.id}>
                  <div
                    role="radio"
                    aria-checked={selected}
                    tabIndex={0}
                    className={`problem-card${selected ? " selected" : ""}`}
                    onClick={() => selectProblem(problem.id)}
                    onKeyDown={(e) => onCardKeyDown(e, problem.id)}
                  >
                    <div className="problem-head">
                      <h3 className="problem-title">{problem.title}</h3>
                      <span className={`source-badge source-${problem.source}`}>
                        {problem.source === "ai" ? "AI" : "Manual"}
                      </span>
                    </div>
                    {problem.description && <p className="problem-desc">{problem.description}</p>}
                    {signalChips(problem).length > 0 && (
                      <div className="chips">
                        {signalChips(problem).map((signal) => (
                          <span key={signal} className="chip">
                            {signal}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="idea-meta">
                      <span>Created {new Date(problem.created_at).toLocaleDateString()}</span>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={deletingProblem === problem.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeProblem(problem);
                        }}
                      >
                        {deletingProblem === problem.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <form className="card problem-form" onSubmit={(e) => void addManualProblem(e)}>
          <h3>Add problem manually</h3>
          <div className="field">
            <label htmlFor="problem-title">Problem</label>
            <input
              id="problem-title"
              type="text"
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              placeholder="A concrete problem your audience has (required)"
              maxLength={120}
              required
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="problem-description">Description</label>
            <textarea
              id="problem-description"
              value={manualDescription}
              onChange={(e) => setManualDescription(e.target.value)}
              placeholder="Optional — who feels it, when it bites, why it hurts"
              maxLength={2000}
              rows={3}
            />
          </div>
          <div className="field">
            <label htmlFor="problem-signals">Search signals</label>
            <input
              id="problem-signals"
              type="text"
              value={manualSignals}
              onChange={(e) => setManualSignals(e.target.value)}
              placeholder="Optional — search queries, separated by semicolons"
              maxLength={1000}
              autoComplete="off"
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-secondary" disabled={addingProblem}>
              {addingProblem ? "Adding…" : "Add problem"}
            </button>
          </div>
          {addError && (
            <p className="error" role="alert">
              {addError}
            </p>
          )}
        </form>
      </section>

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
        {selectedProblem && (
          <p className="field-hint">
            Scoped to selected problem: <strong>{selectedProblem.title}</strong>
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={generating}>
            {generating
              ? "Generating… can take up to a minute"
              : selectedProblem
                ? "Generate ideas for this problem"
                : "Generate"}
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
                <h3 className="idea-title">
                  {idea.title}
                  <ProblemTag problems={problems} problemId={idea.problem_id} />
                </h3>
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

function selectionKey(projectId: string): string {
  return `pg_selected_problem:${projectId}`;
}
