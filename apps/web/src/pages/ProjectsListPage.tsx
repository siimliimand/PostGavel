import { useEffect, useState, type FormEvent } from "react";
import { fetchJson, type Project, type ProjectWithRole } from "../api";
import { Link, navigate } from "../router";

export default function ProjectsListPage() {
  const [projects, setProjects] = useState<ProjectWithRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchJson<ProjectWithRole[]>("/api/projects")
      .then(setProjects)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await fetchJson<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      navigate(`/projects/${project.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <>
      <h1>Projects</h1>

      <form onSubmit={create} className="card create-form">
        <div className="field">
          <label htmlFor="new-project-name">New project name</label>
          <input
            id="new-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Marketing"
            autoComplete="off"
          />
        </div>
        <button type="submit" className="btn" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create project"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      {projects === null && !error && <p className="loading">Loading…</p>}

      {projects !== null && projects.length === 0 && (
        <p className="empty card">
          No projects yet. Create your first project above to get started.
        </p>
      )}

      {projects !== null && projects.length > 0 && (
        <ul className="card project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="project-link">
                <span className="project-name">{project.name}</span>
                <span className="project-meta">
                  <span className="role-badge">{project.role}</span>
                  <span>updated {new Date(project.updated_at).toLocaleDateString()}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
