import { useState, type FormEvent } from "react";
import { authErrorMessage, login, type AuthUser } from "../api";
import { Link, navigate } from "../router";

type Props = { onSignedIn: (user: AuthUser) => void };

export default function LoginPage({ onSignedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await login({ email: email.trim(), password });
      onSignedIn(user);
      navigate("/projects", true);
    } catch (err: unknown) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <main className="container auth-container">
      <form onSubmit={submit} className="card auth-card">
        <h1>Log in</h1>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button type="submit" className="btn" disabled={submitting || !email.trim() || !password}>
          {submitting ? "Logging in…" : "Log in"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          Need an account?{" "}
          <Link href="/register" className="back-link">
            Register
          </Link>
        </p>
      </form>
    </main>
  );
}
