import { useState, type FormEvent } from "react";
import { authErrorMessage, register, type AuthUser } from "../api";
import { Link, navigate } from "../router";

type Props = { onSignedIn: (user: AuthUser) => void };

export default function RegisterPage({ onSignedIn }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    // Client-side mirror of the server's zod rules (password length only —
    // email format is left to the browser's type=email check and the server).
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await register({
        email: email.trim(),
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
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
        <h1>Register</h1>
        <div className="field">
          <label htmlFor="register-name">Name (optional)</label>
          <input
            id="register-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>
        <div className="field">
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div className="field">
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button type="submit" className="btn" disabled={submitting || !email.trim() || password.length < 8}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          Already have an account?{" "}
          <Link href="/login" className="back-link">
            Log in
          </Link>
        </p>
      </form>
    </main>
  );
}
