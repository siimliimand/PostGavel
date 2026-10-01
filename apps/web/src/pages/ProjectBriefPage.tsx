import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, fetchJson, type Project, type ProjectInput } from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

const EMPTY: ProjectInput = { name: "", description: "", content_guidelines: "", content_types: "" };

export default function ProjectBriefPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [form, setForm] = useState<ProjectInput>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setProject(null);
    setNotFound(false);
    setLoadError(null);
    setForm(EMPTY);
    setDirty(false);
    fetchJson<Project>(`/api/projects/${id}`)
      .then((p) => {
        if (!active) return;
        setProject(p);
        setForm({
          name: p.name,
          description: p.description ?? "",
          content_guidelines: p.content_guidelines ?? "",
          content_types: p.content_types ?? "",
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [id]);

  // Clear any pending "Saved" flash on unmount / id change.
  useEffect(() => () => window.clearTimeout(flashTimer.current), [id]);

  const setField = (key: keyof ProjectInput) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await fetchJson<Project>(`/api/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setProject(updated);
      setForm({
        name: updated.name,
        description: updated.description ?? "",
        content_guidelines: updated.content_guidelines ?? "",
        content_types: updated.content_types ?? "",
      });
      setDirty(false);
      setSaved(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (notFound) {
    return (
      <div className="card">
        <h1>Project not found</h1>
        <p>This project doesn't exist or you don't have access to it.</p>
        <Link href="/projects" className="back-link">
          ← Back to projects
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card">
        <h1>Project brief</h1>
        <p className="error" role="alert">
          {loadError}
        </p>
        <Link href="/projects" className="back-link">
          ← Back to projects
        </Link>
      </div>
    );
  }

  if (!project) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <form onSubmit={save} className="card">
        <h1>Project brief</h1>

      <div className="field">
        <label htmlFor="brief-name">Name</label>
        <input
          id="brief-name"
          value={form.name}
          onChange={(e) => setField("name")(e.target.value)}
          required
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label htmlFor="brief-description">What is this project about?</label>
        <textarea
          id="brief-description"
          value={form.description}
          onChange={(e) => setField("description")(e.target.value)}
          rows={4}
        />
      </div>

      <div className="field">
        <label htmlFor="brief-guidelines">How should content be generated?</label>
        <textarea
          id="brief-guidelines"
          value={form.content_guidelines}
          onChange={(e) => setField("content_guidelines")(e.target.value)}
          rows={4}
        />
      </div>

      <div className="field">
        <label htmlFor="brief-content-types">What kind of content?</label>
        <input
          id="brief-content-types"
          value={form.content_types}
          onChange={(e) => setField("content_types")(e.target.value)}
          placeholder="SEO blog posts, newsletters"
          autoComplete="off"
        />
      </div>

      <div className="form-actions">
        <button type="submit" className="btn" disabled={saving || !form.name.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="flash">Saved</span>}
        {dirty && !saved && <span className="dirty-hint">Unsaved changes</span>}
      </div>
      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      <p className="hint">These fields are injected into your AI prompts.</p>
      </form>
    </>
  );
}
