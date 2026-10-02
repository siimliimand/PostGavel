import { useEffect, useState } from "react";
import { marked } from "marked";
import {
  ApiError,
  createDraft,
  deletePiece,
  fetchPieces,
  type Piece,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

/**
 * Friendly message per typed error code — same taxonomy as the Ideas page;
 * the server's own message (truncated provider detail) is the secondary line.
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
  ValidationError: "The request was rejected — see the detail line.",
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

function formatLabel(format: Piece["format"]): string {
  return format === "article" ? "Article" : "Video script";
}

function wordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

/**
 * The model's markdown is rendered for reading only. The raw text is escaped
 * BEFORE parsing so model output (or a prompt override) cannot inject raw
 * HTML/script into the page — markdown formatting still works, tags show as
 * literal text.
 */
function markdownToHtml(markdown: string): string {
  const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return marked.parse(escaped, { async: false, gfm: true, breaks: true });
}

export default function ContentPage({ id }: { id: string }) {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [writing, setWriting] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<GenerateError | null>(null);
  const [writeNote, setWriteNote] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPieces(null);
    setNotFound(false);
    setLoadError(null);
    setWriteError(null);
    setWriteNote(null);
    setDeleteError(null);
    fetchPieces(id)
      .then((list) => {
        if (active) setPieces(list);
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

  const refresh = async () => {
    try {
      setPieces(await fetchPieces(id));
    } catch {
      // Keep the current list; the request error is surfaced separately.
    }
  };

  const writeDraft = async (outline: Piece) => {
    if (writing) return;
    setWriting(outline.id);
    setWriteError(null);
    setWriteNote(null);
    try {
      const result = await createDraft(id, outline.id);
      setPieces(await fetchPieces(id));
      setWriteNote(`Draft written with ${result.model}.`);
    } catch (err: unknown) {
      setWriteError(toGenerateError(err));
      // Nothing partial is stored server-side; resync the list anyway.
      void refresh();
    } finally {
      setWriting(null);
    }
  };

  const remove = async (piece: Piece) => {
    if (deleting) return;
    if (!window.confirm(`Delete the ${piece.type} "${piece.title}"?`)) return;
    setDeleting(piece.id);
    setDeleteError(null);
    try {
      await deletePiece(id, piece.id);
      setPieces((prev) => prev?.filter((row) => row.id !== piece.id) ?? prev);
    } catch (err: unknown) {
      // A 404 just means it is already gone — drop it locally to resync.
      if (err instanceof ApiError && err.status === 404) {
        setPieces((prev) => prev?.filter((row) => row.id !== piece.id) ?? prev);
      } else {
        setDeleteError(errorMessage(err));
      }
    } finally {
      setDeleting(null);
    }
  };

  const copyBody = async (piece: Piece) => {
    try {
      await navigator.clipboard.writeText(piece.body);
      setCopied(piece.id);
      window.setTimeout(() => setCopied((current) => (current === piece.id ? null : current)), 2000);
    } catch {
      setCopied(null);
    }
  };

  if (notFound) {
    return (
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>Content</h1>
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
          <h1>Content</h1>
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

  if (!pieces) return <p className="loading">Loading…</p>;

  const outlines = pieces.filter((piece) => piece.type === "outline");
  const drafts = pieces.filter((piece) => piece.type === "draft");

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>Content</h1>
      <p className="muted">
        Outlines are the review gate — check the structure before writing. A draft is written
        section by section from the approved outline, grounded in the project brief.
      </p>

      {writeNote && (
        <div className="result-note ok" role="status">
          {writeNote}
        </div>
      )}
      {writeError && (
        <div className="error" role="alert">
          <strong>{writeError.message}</strong>
          {writeError.detail && <div className="error-detail">{writeError.detail}</div>}
          {writeError.configLink && (
            <div className="error-detail">
              <Link href={`/projects/${id}/ai-config`}>Open the AI config</Link>
            </div>
          )}
        </div>
      )}

      <section>
        <h2>
          Outlines{outlines.length > 0 && <span className="muted"> ({outlines.length})</span>}
        </h2>
        {outlines.length === 0 ? (
          <p className="empty">
            No outlines yet — open an idea on the Ideas page and pick "Outline article" or
            "Outline video".
          </p>
        ) : (
          <ul className="idea-list">
            {outlines.map((outline) => (
              <li key={outline.id} className="idea-card">
                <h3 className="idea-title">
                  {outline.title}
                  <span className={`format-badge format-${outline.format}`}>
                    {formatLabel(outline.format)}
                  </span>
                </h3>
                <details className="default-details">
                  <summary>
                    Structure ({outline.sections?.length ?? 0}{" "}
                    {outline.sections?.length === 1 ? "section" : "sections"})
                  </summary>
                  <ul className="outline-structure">
                    {(outline.sections ?? []).map((section, index) => (
                      <li key={index}>
                        <strong>{section.heading}</strong>
                        {section.points.length > 0 && (
                          <ul>
                            {section.points.map((point, pointIndex) => (
                              <li key={pointIndex}>{point}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="idea-meta">
                  <span>
                    {outline.model ? `Written with ${outline.model} · ` : ""}
                    Created {new Date(outline.created_at).toLocaleDateString()}
                  </span>
                  <span className="piece-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={writing !== null}
                      onClick={() => void writeDraft(outline)}
                    >
                      Write draft
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={deleting === outline.id}
                      onClick={() => void remove(outline)}
                    >
                      {deleting === outline.id ? "Deleting…" : "Delete"}
                    </button>
                  </span>
                </div>
                {writing === outline.id && (
                  <p className="busy-hint" role="status">
                    <span className="spinner" aria-hidden="true" /> Writing section by section —
                    this can take a minute or two.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>
          Drafts{drafts.length > 0 && <span className="muted"> ({drafts.length})</span>}
        </h2>
        {deleteError && (
          <p className="error" role="alert">
            {deleteError}
          </p>
        )}
        {drafts.length === 0 ? (
          <p className="empty">No drafts yet — approve an outline above and write it.</p>
        ) : (
          <ul className="idea-list">
            {drafts.map((draft) => (
              <li key={draft.id} className="idea-card">
                <h3 className="idea-title">
                  {draft.title}
                  <span className={`format-badge format-${draft.format}`}>
                    {formatLabel(draft.format)}
                  </span>
                </h3>
                <p className="muted piece-wordcount">
                  {wordCount(draft.body)} words · {draft.model ? `written with ${draft.model} · ` : ""}
                  Created {new Date(draft.created_at).toLocaleDateString()}
                </p>
                <details className="default-details">
                  <summary>Preview draft</summary>
                  <div
                    className="markdown-body"
                    // The markdown source is HTML-escaped before parsing (see
                    // markdownToHtml) — model output cannot inject markup here.
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(draft.body) }}
                  />
                </details>
                <div className="idea-meta">
                  <span />
                  <span className="piece-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-secondary"
                      onClick={() => void copyBody(draft)}
                    >
                      {copied === draft.id ? "Copied!" : "Copy markdown"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={deleting === draft.id}
                      onClick={() => void remove(draft)}
                    >
                      {deleting === draft.id ? "Deleting…" : "Delete"}
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
