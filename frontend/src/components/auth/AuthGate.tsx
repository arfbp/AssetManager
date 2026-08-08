"use client";

import { useEffect, useState } from "react";
import { checkSession, getStoredUsername, onUnauthorized } from "@/lib/session";
import { LoginForm } from "./LoginForm";

type GateState =
  | { phase: "checking" }
  | { phase: "authenticated"; username: string }
  | { phase: "unauthenticated" };

/**
 * Gates the whole dashboard behind a real login (server/src/auth/) instead
 * of a static shared token. Checked once on mount via GET /api/auth/me
 * (session.ts's checkSession) so a stale/expired token from a previous
 * visit shows the login form immediately rather than only after the first
 * failed API call. A network error while checking is treated as "probably
 * still logged in" (falls back to the last known username) rather than
 * bouncing to login on a transient blip — a real 401 from any later request
 * still triggers the unauthorized event below.
 */
export function AuthGate({ children }: { children: (username: string) => React.ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;

    checkSession().then((result) => {
      if (cancelled) return;
      if (result.status === "valid") {
        setState({ phase: "authenticated", username: result.username });
      } else if (result.status === "unknown") {
        const stored = getStoredUsername();
        setState(stored ? { phase: "authenticated", username: stored } : { phase: "unauthenticated" });
      } else {
        setState({ phase: "unauthenticated" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onUnauthorized(() => setState({ phase: "unauthenticated" }));
  }, []);

  if (state.phase === "checking") {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading…</div>;
  }

  if (state.phase === "unauthenticated") {
    return <LoginForm onSuccess={(username) => setState({ phase: "authenticated", username })} />;
  }

  return <>{children(state.username)}</>;
}
