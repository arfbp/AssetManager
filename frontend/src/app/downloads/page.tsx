"use client";

import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { getStoredRole } from "@/lib/session";
import { downloadAgentInstaller, ApiError } from "@/lib/api";

function Downloads({ username }: { username: string }) {
  const role = getStoredRole();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (role === "viewer") {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  async function handleDownload(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await downloadAgentInstaller();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Downloads</h1>
          <p className="text-xs text-ink-muted">Install the agent on a new machine to bring it under management.</p>
        </div>

        <div className="glass-card overflow-hidden rounded-xl">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-card-padding">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <span className="material-symbols-outlined text-[24px]">computer</span>
              </span>
              <div>
                <h2 className="font-semibold text-ink-primary">OptiFleet AI Agent — Windows</h2>
                <p className="mt-0.5 text-sm text-ink-secondary">
                  Installs as a background Windows service. Works on any machine with internet access, anywhere —
                  not just this office's network.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy}
              className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">download</span>
              {busy ? "Preparing…" : "Download for Windows"}
            </button>
          </div>

          {error && (
            <p className="border-b border-border bg-status-critical/5 px-card-padding py-3 text-sm text-status-critical">{error}</p>
          )}

          <div className="p-card-padding">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">How to install</h3>
            <ol className="mt-3 space-y-2.5 text-sm text-ink-secondary">
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gridline text-[11px] font-semibold text-ink-primary">
                  1
                </span>
                Copy the downloaded .zip to the target machine and extract it — keep all 6 files together in one folder.
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gridline text-[11px] font-semibold text-ink-primary">
                  2
                </span>
                Double-click <code className="rounded bg-page px-1 py-0.5 text-xs">RUN-ME.bat</code>.
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gridline text-[11px] font-semibold text-ink-primary">
                  3
                </span>
                Click "Yes" on the one Windows admin permission prompt — required to install any Windows service,
                nothing after that needs another click.
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gridline text-[11px] font-semibold text-ink-primary">
                  4
                </span>
                The new device appears on the Devices page within a few seconds.
              </li>
            </ol>

            <div className="mt-4 flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-ink-secondary">
              <span className="material-symbols-outlined text-[16px] text-status-warning">warning</span>
              <p>
                This file carries the real credentials this fleet's agents authenticate with. Only send it to
                machines you intend to manage — don't post it anywhere public.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

export default function DownloadsPage() {
  return <AuthGate>{(username) => <Downloads username={username} />}</AuthGate>;
}
