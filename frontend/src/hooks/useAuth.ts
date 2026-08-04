import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { UserRecord } from "../types";

export type AuthStatus = "checking" | "authenticated" | "anonymous";

export function useAuth() {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [status, setStatus] = useState<AuthStatus>("checking");

  // Runs once on mount: GET /api/auth/me relies entirely on the httpOnly
  // cookie (never read by JS, never stored client-side), so this is the
  // only way the app can know "is there already a valid session" after a
  // page refresh — there's no localStorage flag to check instead.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (!cancelled) {
          setUser(me);
          setStatus("authenticated");
        }
      } catch {
        // A 401 here is the expected, common case (no session yet) — not
        // an error to surface. Any other failure (network down, etc.)
        // still just falls back to "logged out"; there's no useful
        // degraded state to show for "couldn't tell if you're logged in."
        if (!cancelled) setStatus("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const me = await api.login(email, password);
    setUser(me);
    setStatus("authenticated");
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const me = await api.signup(email, password);
    setUser(me);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Clear local state even if the network call fails — the user's
      // intent was to log out, and there's nothing more the client can do
      // about a failed logout request than drop what it locally believes
      // about the session and let the next authenticated request 401 for
      // real if the cookie is somehow still valid server-side.
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  return { user, status, login, signup, logout };
}
