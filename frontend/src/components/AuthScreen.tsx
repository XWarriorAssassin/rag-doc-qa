import { useState } from "react";
import { ApiError } from "../api/client";
import { useAuth } from "../hooks/useAuth";

type Mode = "login" | "signup";

export function AuthScreen({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await auth.login(email, password);
      } else {
        await auth.signup(email, password);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1 className="auth-title">DocuQuery</h1>
        <p className="auth-subtitle">
          {mode === "login" ? "Sign in to your documents" : "Create an account to get started"}
        </p>

        {error && <div className="error-banner">{error}</div>}

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            disabled={submitting}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            disabled={submitting}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button type="submit" className="send-btn auth-submit" disabled={submitting}>
          {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          className="auth-switch"
          disabled={submitting}
          onClick={() => {
            setMode((m) => (m === "login" ? "signup" : "login"));
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
