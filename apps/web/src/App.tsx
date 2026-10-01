import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { logout as apiLogout, me as fetchMe, type AuthUser } from "./api";
import AiConfigPage from "./pages/AiConfigPage";
import IdeasPage from "./pages/IdeasPage";
import LoginPage from "./pages/LoginPage";
import ProjectBriefPage from "./pages/ProjectBriefPage";
import PromptsPage from "./pages/PromptsPage";
import ProjectsListPage from "./pages/ProjectsListPage";
import RegisterPage from "./pages/RegisterPage";
import { Link, navigate, RouterProvider, useRoute } from "./router";

// --- Auth context (plan §4/§7) ---------------------------------------------

type AuthContextValue = {
  user: AuthUser | null;
  /** True until the initial /api/auth/me lookup settles — guards against redirect flicker. */
  loading: boolean;
  setUser: (user: AuthUser | null) => void;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  setUser: () => {},
});

function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>{children}</AuthContext.Provider>
  );
}

// --- Chrome -----------------------------------------------------------------

function TopBar() {
  const { user, setUser } = useAuth();

  const signOut = async () => {
    try {
      await apiLogout();
    } catch {
      // Best effort: the UI signs out regardless of what the server answered.
    }
    setUser(null);
    navigate("/login", true);
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/projects" className="brand">
          PostGavel
        </Link>
        {user && (
          <div className="topbar-user">
            <span className="user-email">{user.email}</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={signOut}>
              Log out
            </button>
          </div>
        )}
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

// --- Routing ----------------------------------------------------------------

function Routes() {
  const { segments } = useRoute();
  const { user, loading, setUser } = useAuth();

  // Decide redirects only after the /me lookup: a signed-in user opening the
  // app must not flicker through /login.
  if (loading) {
    return (
      <main className="container">
        <p className="loading">Loading…</p>
      </main>
    );
  }

  const authPage = segments.length === 1 && (segments[0] === "login" || segments[0] === "register");

  // Route guard: signed out users only see /login and /register; signed-in
  // users skip straight past them.
  if (!user && !authPage) return <Redirect to="/login" />;
  if (user && authPage) return <Redirect to="/projects" />;

  if (authPage) {
    return segments[0] === "login" ? (
      <LoginPage onSignedIn={setUser} />
    ) : (
      <RegisterPage onSignedIn={setUser} />
    );
  }

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
    <AuthProvider>
      <RouterProvider>
        <Routes />
      </RouterProvider>
    </AuthProvider>
  );
}
