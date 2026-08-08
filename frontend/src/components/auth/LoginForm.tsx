"use client";

import { useState, type FormEvent } from "react";
import { login } from "@/lib/session";

// Deliberately a fixed dark "tech" treatment regardless of the app's own
// light/dark toggle — same reasoning as AppShell's sidebar (see its own doc
// comment): a login screen is seen once per session, before any theme
// preference has even loaded, so it doesn't need to track it.
export function LoginForm({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const loggedInUsername = await login(username.trim(), password);
      onSuccess(loggedInUsername);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#060c18] p-4">
      {/* Ambient glow + circuit-grid texture — the "tech" backdrop. Pure CSS,
          no images: two radial gradients for the glow, a repeating linear
          gradient pair for the grid lines. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, rgba(6,182,242,0.16), transparent 70%), radial-gradient(40% 40% at 85% 90%, rgba(29,78,216,0.18), transparent 70%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "42px 42px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent)",
        }}
      />

      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-[#1d4ed8]/30 to-[#06b6f2]/20 shadow-[0_0_24px_rgba(6,182,242,0.25)]">
            <img src="/bilibili-icon.svg" alt="bilibili" className="h-7 w-auto" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">OptiFleet AI</h1>
            <p className="mt-0.5 text-xs text-white/50">AI-powered device fleet console</p>
          </div>
        </div>

        <div className="mt-6 border-t border-white/10 pt-5">
          <div className="space-y-3">
            <label className="block text-xs font-medium text-white/60">
              Username
              <div className="relative mt-1.5">
                <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-white/35">
                  person
                </span>
                <input
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-lg border border-white/10 bg-black/25 py-2.5 pl-10 pr-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#6ea8ff]/50 focus:ring-2 focus:ring-[#6ea8ff]/30 disabled:opacity-50"
                />
              </div>
            </label>
            <label className="block text-xs font-medium text-white/60">
              Password
              <div className="relative mt-1.5">
                <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-white/35">
                  lock
                </span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-lg border border-white/10 bg-black/25 py-2.5 pl-10 pr-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#6ea8ff]/50 focus:ring-2 focus:ring-[#6ea8ff]/30 disabled:opacity-50"
                />
              </div>
            </label>
          </div>

          {error && (
            <p className="mt-3 flex items-center gap-1.5 rounded-md border border-red-400/20 bg-red-400/10 px-2.5 py-2 text-xs text-red-300">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#1d4ed8] to-[#0891b2] px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1d4ed8]/20 transition-all hover:shadow-[#06b6f2]/30 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            {busy ? (
              "Signing in…"
            ) : (
              <>
                Sign in
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </>
            )}
          </button>

          <p className="mt-5 text-center text-[11px] text-white/35">
            No account? An administrator creates accounts with <code className="text-white/50">npm run user:create</code> on the server.
          </p>
        </div>
      </form>

      <img
        src="/bilibili-logo.svg"
        alt="bilibili"
        className="absolute bottom-6 left-1/2 z-10 h-4 w-auto -translate-x-1/2 opacity-60"
      />
    </div>
  );
}
