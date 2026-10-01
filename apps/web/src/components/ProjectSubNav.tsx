import { Link, useRoute } from "../router";

/**
 * Project sub-navigation, shared by all /projects/:id/* pages. Later phases
 * append Prompts/Ideas/Members entries to this row.
 */
export default function ProjectSubNav({ id }: { id: string }) {
  const { path } = useRoute();
  const items = [
    { to: `/projects/${id}`, label: "Brief" },
    { to: `/projects/${id}/ai-config`, label: "AI config" },
    { to: `/projects/${id}/prompts`, label: "Prompts" },
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
