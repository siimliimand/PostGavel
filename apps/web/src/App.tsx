import { useEffect, type ReactNode } from "react";
import AiConfigPage from "./pages/AiConfigPage";
import IdeasPage from "./pages/IdeasPage";
import ProjectBriefPage from "./pages/ProjectBriefPage";
import PromptsPage from "./pages/PromptsPage";
import ProjectsListPage from "./pages/ProjectsListPage";
import { Link, navigate, RouterProvider, useRoute } from "./router";

function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/projects" className="brand">
          PostGavel
        </Link>
      </div>
    </header>
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <>
      <TopBar />
      <main className="container">{children}</main>
    </>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, true);
  }, [to]);
  return null;
}

function Routes() {
  const { segments } = useRoute();

  if (segments.length === 0) return <Redirect to="/projects" />;

  if (segments[0] === "projects") {
    if (segments.length === 1) {
      return (
        <Screen>
          <ProjectsListPage />
        </Screen>
      );
    }
    if (segments.length === 2) {
      return (
        <Screen>
          <ProjectBriefPage id={segments[1]} />
        </Screen>
      );
    }
    if (segments.length === 3 && segments[2] === "ai-config") {
      return (
        <Screen>
          <AiConfigPage id={segments[1]} />
        </Screen>
      );
    }
    if (segments.length === 3 && segments[2] === "prompts") {
      return (
        <Screen>
          <PromptsPage id={segments[1]} />
        </Screen>
      );
    }
    if (segments.length === 3 && segments[2] === "ideas") {
      return (
        <Screen>
          <IdeasPage id={segments[1]} />
        </Screen>
      );
    }
  }

  return (
    <Screen>
      <div className="card">
        <h1>Page not found</h1>
        <p>
          <Link href="/projects" className="back-link">
            ← Back to projects
          </Link>
        </p>
      </div>
    </Screen>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <Routes />
    </RouterProvider>
  );
}
