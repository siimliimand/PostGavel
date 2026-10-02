import { Link, useRoute } from "../router";

/**
 * Project sub-navigation, shared by all /projects/:id/* pages. Members is the
 * remaining later addition to this row.
 */
export default function ProjectSubNav({ id }: { id: string }) {
  const { path } = useRoute();
  const items = [
    { to: `/projects/${id}`, label: "Brief" },
    { to: `/projects/${id}/ai-config`, label: "AI config" },
    { to: `/projects/${id}/prompts`, label: "Prompts" },
    { to: `/projects/${id}/content`, label: "Content" },
    { to: `/projects/${id}/ideas`, label: "Ideas" },
  ];
  return (
    <nav className="subnav" aria-label="Project sections">
      {items.map((item) => (
        <Link
          key={item.to}
          href={item.to}
          className={`subnav-link${path === item.to ? " active" : ""}`}
          aria-current={path === item.to ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
