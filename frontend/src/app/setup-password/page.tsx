"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, setupPassword } from "@/lib/api";

// Public — reached from a freshly created org's invite email/link, before
// any session exists (see server/src/api/routes.ts's POST /orgs and
// /auth/setup-password). Same dark "tech" treatment as LoginForm, since
// this is the other half of the same "before you're logged in" moment.
function SetupPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password.length < 8 || password !== confirm || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setupPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try the link again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#060c18] p-4">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, rgba(6,182,242,0.16), transparent 70%), radial-gradient(40% 40% at 85% 90%, rgba(25,87,194,0.18), transparent 70%)",
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

      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/50 backdrop-blur-xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-[#1957c2]/30 to-[#06b6f2]/20 shadow-[0_0_24px_rgba(6,182,242,0.25)]">
            <span className="material-symbols-outlined text-[26px] text-white">lock_open</span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">Set your password</h1>
            <p className="mt-0.5 text-xs text-white/50">OptiFleet AI — finish setting up your account</p>
          </div>
        </div>

        <div className="mt-6 border-t border-white/10 pt-5">
          {!token ? (
            <p className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
              This link is missing its setup token. Ask whoever invited you for a fresh link.
            </p>
          ) : done ? (
            <div className="text-center">
              <p className="flex items-center justify-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-2 text-xs text-emerald-300">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Password set. You can sign in now.
              </p>
              <a href="/" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#1957c2] to-[#0891b2] px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1957c2]/20 transition-all hover:shadow-[#06b6f2]/30">
                Go to sign in
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <label className="block text-xs font-medium text-white/60">
                New password
                <input
                  autoFocus
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#5b9dff]/50 focus:ring-2 focus:ring-[#5b9dff]/30 disabled:opacity-50"
                />
              </label>
              <label className="block text-xs font-medium text-white/60">
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#5b9dff]/50 focus:ring-2 focus:ring-[#5b9dff]/30 disabled:opacity-50"
                />
              </label>

              {password && password.length < 8 && <p className="text-[11px] text-white/40">At least 8 characters.</p>}
              {confirm && password !== confirm && <p className="text-[11px] text-amber-300/80">Passwords don't match.</p>}

              {error && (
                <p className="flex items-center gap-1.5 rounded-md border border-red-400/20 bg-red-400/10 px-2.5 py-2 text-xs text-red-300">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || password.length < 8 || password !== confirm}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#1957c2] to-[#0891b2] px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1957c2]/20 transition-all hover:shadow-[#06b6f2]/30 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
              >
                {busy ? "Setting password…" : "Set password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SetupPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetupPasswordForm />
    </Suspense>
  );
}
