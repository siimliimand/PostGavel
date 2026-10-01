import { useEffect, useState } from "react";

type Health = { ok: boolean; service: string; time: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
      )
      .then(setHealth)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  return (
    <main className="container">
      <h1>PostGavel</h1>
      <p className="hello">Hello — this page is served by the PostGavel worker.</p>
      <p className="status">
        {error ? (
          <>
            API health: <strong className="bad">unreachable</strong> ({error})
          </>
        ) : health ? (
          <>
            API health: <strong className="good">ok</strong>{" "}
            <span className="time">{health.time}</span>
          </>
        ) : (
          "Checking API health…"
        )}
      </p>
    </main>
  );
}
