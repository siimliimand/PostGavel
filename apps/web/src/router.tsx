import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export type Route = {
  /** Pathname, e.g. "/projects/abc" */
  path: string;
  /** Non-empty path segments, e.g. ["projects", "abc"] */
  segments: string[];
};

const RouteContext = createContext<Route>({ path: "/", segments: [] });

function currentPath(): string {
  return window.location.pathname;
}

/**
 * Client-side navigation. notify=true (default) makes the RouterProvider
 * re-render; the popstate event doubles as our internal change signal.
 */
export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);

  // Layout effect: it must be subscribed before children's passive effects run,
  // otherwise a navigate() fired from a child effect (e.g. the "/" redirect)
  // dispatches popstate with no listener attached and the router never updates.
  useLayoutEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <RouteContext.Provider value={{ path, segments: path.split("/").filter(Boolean) }}>
      {children}
    </RouteContext.Provider>
  );
}

export function useRoute(): Route {
  return useContext(RouteContext);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** Anchor that intercepts plain left-clicks and routes client-side instead. */
export function Link({ href, children, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Let the browser handle modified clicks (new tab/window) and downloads.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
