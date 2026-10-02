import { useEffect, useState } from "react";
import { marked } from "marked";
import {
  ApiError,
  createDerivative,
  createDraft,
  deletePiece,
  fetchPieces,
  type Derivative,
  type DerivativeKind,
  type MetaPackage,
  type Piece,
  type YoutubePackage,
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

// --- Publish kit (Phase 11) -------------------------------------------------

/** Human labels for the derivative kinds (buttons, notes, busy text). */
const DERIVATIVE_LABELS: Record<DerivativeKind, string> = {
  meta: "Meta package",
  linkedin_post: "LinkedIn post",
  x_thread: "X thread",
  newsletter_blurb: "Newsletter blurb",
  youtube_package: "YouTube package",
};

/** Meta package fields in render order: key in the JSON body → row label. */
const META_FIELDS = [
  ["meta_title", "Meta title"],
  ["meta_description", "Meta description"],
  ["slug", "Slug"],
  ["excerpt", "Excerpt"],
] as const;

/** The article draft's prose derivative kinds, in button order. */
const ARTICLE_PROSE_KINDS = ["linkedin_post", "x_thread", "newsletter_blurb"] as const;

/** JSON body of a structured derivative, or null when absent/unparsable (the
 * raw body is shown as text in that case — model output is never fatal). */
function parseKitBody<T>(derivative: Derivative | undefined): T | null {
  if (!derivative) return null;
  try {
    return JSON.parse(derivative.body) as T;
  } catch {
    return null;
  }
}

type PublishKitProps = {
  draft: Piece;
  /** `${pieceId}:${kind}` of the in-flight generation, if any. */
  generating: string | null;
  copied: string | null;
  onGenerate: (draft: Piece, kind: DerivativeKind) => void;
  onCopy: (key: string, text: string) => void;
};

/** The publish kit block on a draft card: meta/social/newsletter for article
 * drafts, the YouTube package for video drafts. One AI call per kind. */
function PublishKit({ draft, generating, copied, onGenerate, onCopy }: PublishKitProps) {
  const byKind = new Map(draft.derivatives.map((row) => [row.kind, row]));
  const busyKind = generating?.startsWith(`${draft.id}:`)
    ? (generating.split(":")[1] as DerivativeKind)
    : null;

  const head = (kind: DerivativeKind, row: Derivative | undefined) => (
    <div className="kit-block-head">
      <span className="kit-kind-label">{DERIVATIVE_LABELS[kind]}</span>
      {row && (
        <span className="piece-actions">
          <button
            type="button"
            className="btn btn-small btn-secondary"
            onClick={() => onCopy(`${row.id}:all`, row.body)}
          >
            {copied === `${row.id}:all` ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            className="btn btn-small btn-secondary kit-regen"
            title={`Regenerate ${DERIVATIVE_LABELS[kind]}`}
            aria-label={`Regenerate ${DERIVATIVE_LABELS[kind]}`}
            disabled={generating !== null}
            onClick={() => onGenerate(draft, kind)}
          >
            ↻
          </button>
        </span>
      )}
    </div>
  );

  // Buttons stay honest: while any kit generation runs, the rest are disabled.
  const generateButton = (kind: DerivativeKind) => (
    <button
      type="button"
      className="btn btn-small"
      disabled={generating !== null}
      onClick={() => onGenerate(draft, kind)}
    >
      {busyKind === kind
        ? "Generating…"
        : byKind.has(kind)
          ? `Regenerate ${DERIVATIVE_LABELS[kind]}`
          : `Generate ${DERIVATIVE_LABELS[kind]}`}
    </button>
  );

  const metaRow = byKind.get("meta");
  const meta = parseKitBody<MetaPackage>(metaRow);
  const youtubeRow = byKind.get("youtube_package");
  const youtube = parseKitBody<YoutubePackage>(youtubeRow);

  return (
    <details className="default-details kit-details">
      <summary>Publish kit</summary>
      <div className="publish-kit">
        {draft.format === "article" ? (
          <>
            <div className="kit-block">
              {metaRow && meta ? (
                <>
                  {head("meta", metaRow)}
                  <dl className="kit-meta-list">
                    {META_FIELDS.map(([field, label]) => (
                      <div className="kit-meta-row" key={field}>
                        <dt>{label}</dt>
                        <dd>{meta[field]}</dd>
                        <button
                          type="button"
                          className="btn btn-small btn-secondary"
                          onClick={() => onCopy(`${metaRow.id}:${field}`, meta[field])}
                        >
                          {copied === `${metaRow.id}:${field}` ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                generateButton("meta")
              )}
            </div>
            {ARTICLE_PROSE_KINDS.map((kind) => {
              const row = byKind.get(kind);
              return (
                <div className="kit-block" key={kind}>
                  {row ? (
                    <>
                      {head(kind, row)}
                      <p className="kit-text">{row.body}</p>
                    </>
                  ) : (
                    generateButton(kind)
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <div className="kit-block">
            {youtubeRow && youtube ? (
              <>
                {head("youtube_package", youtubeRow)}
                <dl className="kit-meta-list">
                  {youtube.titles.map((title, index) => (
                    <div className="kit-meta-row" key={index}>
                      <dt>Title {index + 1}</dt>
                      <dd>{title}</dd>
                      <button
                        type="button"
                        className="btn btn-small btn-secondary"
                        onClick={() => onCopy(`${youtubeRow.id}:title${index}`, title)}
                      >
                        {copied === `${youtubeRow.id}:title${index}` ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  ))}
                </dl>
                <div className="kit-block-head">
                  <span className="kit-kind-label">Description</span>
                  <button
                    type="button"
                    className="btn btn-small btn-secondary"
                    onClick={() => onCopy(`${youtubeRow.id}:description`, youtube.description)}
                  >
                    {copied === `${youtubeRow.id}:description` ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="kit-text kit-text-pre">{youtube.description}</p>
              </>
            ) : (
              generateButton("youtube_package")
            )}
          </div>
        )}
        {busyKind && (
          <p className="busy-hint" role="status">
            <span className="spinner" aria-hidden="true" /> Generating{" "}
            {DERIVATIVE_LABELS[busyKind]} — one AI call, usually a few seconds.
          </p>
        )}
      </div>
    </details>
  );
}

export default function ContentPage({ id }: { id: string }) {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [writing, setWriting] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<GenerateError | null>(null);
  const [writeNote, setWriteNote] = useState<string | null>(null);

  /** `${pieceId}:${kind}` while a publish-kit derivative is being generated. */
  const [generating, setGenerating] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Key of the last copy action (piece body or one kit field). */
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

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      setCopied(null);
    }
  };

  const copyBody = async (piece: Piece) => {
    await copyText(`${piece.id}:body`, piece.body);
  };

  /** Generates (or regenerates) one publish-kit derivative — one AI call. */
  const generateDerivative = async (draft: Piece, kind: DerivativeKind) => {
    if (generating) return;
    setGenerating(`${draft.id}:${kind}`);
    setWriteError(null);
    setWriteNote(null);
    try {
      const result = await createDerivative(id, draft.id, kind);
      setPieces(await fetchPieces(id));
      setWriteNote(`${DERIVATIVE_LABELS[kind]} generated with ${result.model}.`);
    } catch (err: unknown) {
      setWriteError(toGenerateError(err));
      // Resync anyway — the failed call may still have replaced nothing, but
      // the server state (upsert row, rate-limit window) is authoritative.
      void refresh();
    } finally {
      setGenerating(null);
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
        section by section from the approved outline, grounded in the project brief. Every finished
        draft carries a publish kit: publishing metadata and social derivatives, one AI call each.
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
                <PublishKit
                  draft={draft}
                  generating={generating}
                  copied={copied}
                  onGenerate={(piece, kind) => void generateDerivative(piece, kind)}
                  onCopy={(key, text) => void copyText(key, text)}
                />
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
