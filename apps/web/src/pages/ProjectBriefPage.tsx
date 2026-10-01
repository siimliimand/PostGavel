import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  fetchJson,
  type AudienceExpertise,
  type Project,
  type ProjectInput,
} from "../api";
import ProjectSubNav from "../components/ProjectSubNav";
import { Link } from "../router";

const TONE_PRESETS = [
  "Professional",
  "Conversational",
  "Authoritative",
  "Friendly",
  "Playful",
  "Inspirational",
];

const EXPERTISE_OPTIONS: Array<{ value: AudienceExpertise; label: string }> = [
  { value: "beginners", label: "Beginners" },
  { value: "general", label: "General audience" },
  { value: "practitioners", label: "Practitioners" },
  { value: "experts", label: "Experts" },
];

const CONTENT_TYPE_PRESETS = [
  "Blog post",
  "SEO article",
  "Newsletter",
  "Case study",
  "Tutorial",
  "Comparison",
  "Landing page",
];

const MAX_CONTENT_TYPES = 12;
const MAX_CONTENT_TYPE_LENGTH = 40;
const MAX_TONE = 100;
const MAX_AUDIENCE_DESCRIPTION = 500;
const MAX_GUIDELINE_RULE = 2000;

/** Edit-time shape: unset optional fields are "" and become null on save. */
type BriefForm = {
  name: string;
  description: string;
  content_guidelines: string;
  content_types: string[];
  tone: string; // "" = unset; presets verbatim; anything else = custom
  audience_expertise: AudienceExpertise | ""; // "" = unset
  audience_description: string;
  guidelines_always: string;
  guidelines_never: string;
};

function toForm(p: Project): BriefForm {
  return {
    name: p.name,
    description: p.description ?? "",
    content_guidelines: p.content_guidelines ?? "",
    // Canonicalize on load: legacy labels ("Seo blog post") render as (and are
    // stored back as) their canonical preset chip ("SEO article").
    content_types: p.content_types.map(canonicalType),
    tone: p.tone ?? "",
    audience_expertise: p.audience_expertise ?? "",
    audience_description: p.audience_description ?? "",
    guidelines_always: p.guidelines_always ?? "",
    guidelines_never: p.guidelines_never ?? "",
  };
}

function toInput(f: BriefForm): ProjectInput {
  return {
    name: f.name,
    description: f.description,
    content_guidelines: f.content_guidelines,
    content_types: f.content_types,
    tone: f.tone.trim() || null,
    audience_expertise: f.audience_expertise || null,
    audience_description: f.audience_description.trim() || null,
    guidelines_always: f.guidelines_always.trim() || null,
    guidelines_never: f.guidelines_never.trim() || null,
  };
}

// Case-insensitive preset matching maps every stored value onto a canonical
// chip. Legacy data written before the chip UI used other labels (the oldest
// real row says "Seo blog post"), so a tiny alias table bridges those; the
// canonical label is stored back on the next save.
const CONTENT_TYPE_ALIASES: Record<string, string> = {
  "seo blog post": "SEO article",
};

function matchingPreset(value: string): string | null {
  const lower = value.toLowerCase();
  return (
    CONTENT_TYPE_ALIASES[lower] ??
    CONTENT_TYPE_PRESETS.find((preset) => preset.toLowerCase() === lower) ??
    null
  );
}

function canonicalType(value: string): string {
  return matchingPreset(value) ?? value;
}

/** Select choice for a tone value: "" (unset), the preset, or "custom". */
function toneChoiceFor(tone: string): string {
  if (tone === "") return "";
  return TONE_PRESETS.includes(tone) ? tone : "custom";
}

export default function ProjectBriefPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [form, setForm] = useState<BriefForm>({
    name: "",
    description: "",
    content_guidelines: "",
    content_types: [],
    tone: "",
    audience_expertise: "",
    audience_description: "",
    guidelines_always: "",
    guidelines_never: "",
  });
  // The Rules card starts open only when there is something in it.
  const [rulesOpen, setRulesOpen] = useState(false);

  const [customType, setCustomType] = useState("");
  const [typeError, setTypeError] = useState<string | null>(null);

  // The tone select's own choice: "" (unset), a preset, or "custom". Kept
  // separate from form.tone because a Custom… pick must reveal the input even
  // while the custom draft is still empty.
  const [toneChoice, setToneChoice] = useState("");

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
    setDirty(false);
    fetchJson<Project>(`/api/projects/${id}`)
      .then((p) => {
        if (!active) return;
        setProject(p);
        setForm(toForm(p));
        setToneChoice(toneChoiceFor(p.tone ?? ""));
        setRulesOpen(Boolean(p.guidelines_always || p.guidelines_never));
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

  const setField =
    <K extends keyof BriefForm>(key: K) =>
    (value: BriefForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setDirty(true);
    };

  // Tone select: the choice state drives what is selected/revealed; "custom"
  // keeps any existing custom draft, otherwise starts the input empty.
  const isCustomTone = toneChoice === "custom";

  const setToneSelect = (value: string) => {
    setToneChoice(value);
    if (value === "custom") {
      setForm((prev) => ({ ...prev, tone: TONE_PRESETS.includes(prev.tone) ? "" : prev.tone }));
    } else {
      setField("tone")(value);
    }
    setDirty(true);
  };

  const isSelectedType = (value: string) =>
    form.content_types.some((t) => t.toLowerCase() === value.toLowerCase());

  const toggleType = (value: string) => {
    setTypeError(null);
    setForm((prev) => {
      if (isSelectedType(value)) {
        return {
          ...prev,
          content_types: prev.content_types.filter((t) => t.toLowerCase() !== value.toLowerCase()),
        };
      }
      if (prev.content_types.length >= MAX_CONTENT_TYPES) return prev;
      return { ...prev, content_types: [...prev.content_types, value] };
    });
    setDirty(true);
  };

  const addCustomType = () => {
    const value = customType.trim();
    if (!value) return;
    if (value.length > MAX_CONTENT_TYPE_LENGTH) {
      setTypeError(`Keep custom formats under ${MAX_CONTENT_TYPE_LENGTH} characters.`);
      return;
    }
    if (isSelectedType(value)) {
      setTypeError("That format is already selected.");
      return;
    }
    if (form.content_types.length >= MAX_CONTENT_TYPES) {
      setTypeError(`At most ${MAX_CONTENT_TYPES} formats — remove one first.`);
      return;
    }
    setTypeError(null);
    setForm((prev) => ({ ...prev, content_types: [...prev.content_types, value] }));
    setCustomType("");
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
        body: JSON.stringify(toInput(form)),
      });
      setProject(updated);
      setForm(toForm(updated));
      setToneChoice(toneChoiceFor(updated.tone ?? ""));
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
      <>
        <ProjectSubNav id={id} />
        <div className="card">
          <h1>Project not found</h1>
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
          <h1>Project brief</h1>
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

  if (!project) return <p className="loading">Loading…</p>;

  return (
    <>
      <ProjectSubNav id={id} />
      <h1>Project brief</h1>
      <p className="muted">
        This brief is injected into every AI prompt as <code>{"{{variables}}"}</code> — the fuller
        the About, Audience &amp; voice and Formats fields, the better the generated ideas fit your
        project.
      </p>

      <form onSubmit={save}>
        <section className="card">
          <h2>About</h2>
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
        </section>

        <section className="card">
          <h2>Audience &amp; voice</h2>
          <div className="field">
            <label htmlFor="brief-tone">Tone of voice</label>
            <select id="brief-tone" value={toneChoice} onChange={(e) => setToneSelect(e.target.value)}>
              <option value="">—</option>
              {TONE_PRESETS.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </div>
          {isCustomTone && (
            <div className="field">
              <label htmlFor="brief-tone-custom">Custom tone</label>
              <input
                id="brief-tone-custom"
                value={form.tone}
                onChange={(e) => setField("tone")(e.target.value)}
                placeholder="e.g. Witty, dry humour"
                maxLength={MAX_TONE}
                autoComplete="off"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="brief-expertise">Audience expertise</label>
            <select
              id="brief-expertise"
              value={form.audience_expertise}
              onChange={(e) => setField("audience_expertise")(e.target.value as BriefForm["audience_expertise"])}
            >
              <option value="">—</option>
              {EXPERTISE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="brief-audience">Audience description</label>
            <input
              id="brief-audience"
              value={form.audience_description}
              onChange={(e) => setField("audience_description")(e.target.value)}
              placeholder="e.g. Solo founders picking their first tools"
              maxLength={MAX_AUDIENCE_DESCRIPTION}
              autoComplete="off"
            />
          </div>
        </section>

        <section className="card">
          <h2>Rules</h2>
          <details
            className="rules-details"
            open={rulesOpen}
            onToggle={(e) => setRulesOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Always / never (optional)</summary>
            <div className="field">
              <label htmlFor="brief-always">Always include</label>
              <textarea
                id="brief-always"
                value={form.guidelines_always}
                onChange={(e) => setField("guidelines_always")(e.target.value)}
                rows={3}
                maxLength={MAX_GUIDELINE_RULE}
                placeholder="e.g. Cite primary sources; one concrete example per section"
              />
            </div>
            <div className="field">
              <label htmlFor="brief-never">Never include</label>
              <textarea
                id="brief-never"
                value={form.guidelines_never}
                onChange={(e) => setField("guidelines_never")(e.target.value)}
                rows={3}
                maxLength={MAX_GUIDELINE_RULE}
                placeholder="e.g. No pricing claims; no competitor comparisons"
              />
            </div>
          </details>
        </section>

        <section className="card">
          <h2>Formats</h2>
          <div className="field">
            <label>What kind of content?</label>
            <div className="chips chip-select" role="group" aria-label="Content types">
              {form.content_types.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="chip-btn active"
                  aria-pressed="true"
                  onClick={() => toggleType(type)}
                >
                  {matchingPreset(type) ?? type} <span aria-hidden="true">✕</span>
                </button>
              ))}
              {CONTENT_TYPE_PRESETS.filter((preset) => !isSelectedType(preset)).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chip-btn"
                  aria-pressed="false"
                  onClick={() => toggleType(preset)}
                >
                  {preset} <span aria-hidden="true">+</span>
                </button>
              ))}
            </div>
            <div className="add-type-row">
              <input
                id="brief-add-type"
                value={customType}
                onChange={(e) => {
                  setCustomType(e.target.value);
                  setTypeError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomType();
                  }
                }}
                placeholder="Add custom format…"
                maxLength={MAX_CONTENT_TYPE_LENGTH}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={addCustomType}
                disabled={!customType.trim() || form.content_types.length >= MAX_CONTENT_TYPES}
              >
                Add
              </button>
            </div>
            {typeError && (
              <p className="field-error" role="alert">
                {typeError}
              </p>
            )}
            <p className="field-hint">
              Click a format to add or remove it (up to {MAX_CONTENT_TYPES}). The AI only pitches
              these content types.
            </p>
          </div>
          <div className="field">
            <label htmlFor="brief-notes">Additional notes</label>
            <textarea
              id="brief-notes"
              value={form.content_guidelines}
              onChange={(e) => setField("content_guidelines")(e.target.value)}
              rows={4}
            />
            <p className="field-hint">Anything else the AI should know — free-form.</p>
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
        </section>
      </form>
    </>
  );
}
