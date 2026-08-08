"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { getStoredRole } from "@/lib/session";
import {
  getAgentBuilds,
  uploadAgentBuild,
  activateAgentBuild,
  ApiError,
  type AgentBuildsOverview,
} from "@/lib/api";

function StatusPill({ tone, children }: { tone: "good" | "warning" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "good"
      ? "bg-status-good/10 text-status-good"
      : tone === "warning"
        ? "bg-status-warning/10 text-status-warning"
        : "bg-gridline text-ink-muted";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function AgentUpdates({ username }: { username: string }) {
  const role = getStoredRole();
  const [data, setData] = useState<AgentBuildsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadVersion, setUploadVersion] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    getAgentBuilds()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load."));
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 10_000); // agents converge on their next heartbeat, not instantly
    return () => clearInterval(timer);
  }, [reload]);

  if (role !== "admin") {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  async function handleActivate(version: string): Promise<void> {
    setBusyVersion(version);
    setError(null);
    try {
      await activateAgentBuild(version);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to activate.");
    } finally {
      setBusyVersion(null);
    }
  }

  async function handleUpload(): Promise<void> {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !uploadVersion.trim()) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      await uploadAgentBuild(file, uploadVersion.trim());
      setUploadVersion("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      reload();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">system_update</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Agent Updates</h1>
            <p className="text-xs text-ink-muted">
              Every agent build ever pushed, which one the fleet is converging to, and who's still pending.
            </p>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-status-critical/30 bg-status-critical/5 p-3 text-sm text-status-critical">
            {error}
          </p>
        )}

        <div className="glass-card overflow-hidden rounded-xl">
          <div className="border-b border-border p-card-padding">
            <h2 className="font-semibold text-ink-primary">Build history</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Activating a version is instant — no server restart. Every connected agent picks it up (or rolls back
              to it) on its next heartbeat.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-card-padding py-2 font-medium">Version</th>
                <th className="px-card-padding py-2 font-medium">SHA256</th>
                <th className="px-card-padding py-2 font-medium">Uploaded</th>
                <th className="px-card-padding py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data?.builds.map((b) => {
                const isActive = b.version === data.activeVersion;
                return (
                  <tr key={b.version} className="border-b border-border last:border-0">
                    <td className="px-card-padding py-2 font-mono text-ink-primary">{b.version}</td>
                    <td className="px-card-padding py-2 font-mono text-xs text-ink-muted">{b.sha256.slice(0, 12)}…</td>
                    <td className="px-card-padding py-2 text-ink-secondary">{new Date(b.uploadedAt).toLocaleString()}</td>
                    <td className="px-card-padding py-2 text-right">
                      {isActive ? (
                        <StatusPill tone="good">ACTIVE</StatusPill>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleActivate(b.version)}
                          disabled={busyVersion === b.version}
                          className="rounded-lg border border-border bg-page px-3 py-1 text-xs font-medium text-ink-primary hover:bg-gridline disabled:opacity-50"
                        >
                          {busyVersion === b.version ? "Activating…" : "Set active"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {data && data.builds.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-card-padding py-6 text-center text-sm text-ink-muted">
                    No builds uploaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="glass-card flex flex-col gap-3 rounded-xl p-card-padding">
          <h2 className="font-semibold text-ink-primary">Upload a new build</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".exe" className="text-sm text-ink-secondary" />
            <input
              type="text"
              value={uploadVersion}
              onChange={(e) => setUploadVersion(e.target.value)}
              placeholder="version, e.g. 2026.08.06-1"
              className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploadBusy || !uploadVersion.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {uploadBusy ? "Uploading…" : "Upload"}
            </button>
          </div>
          {uploadError && <p className="text-xs text-status-critical">{uploadError}</p>}
          <p className="text-xs text-ink-muted">Uploading doesn't activate it — do that from the table above.</p>
        </div>

        <div className="glass-card overflow-hidden rounded-xl">
          <div className="border-b border-border p-card-padding">
            <h2 className="font-semibold text-ink-primary">Fleet status</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-card-padding py-2 font-medium">Device</th>
                <th className="px-card-padding py-2 font-medium">Online</th>
                <th className="px-card-padding py-2 font-medium">Version</th>
                <th className="px-card-padding py-2 font-medium">Update status</th>
              </tr>
            </thead>
            <tbody>
              {data?.agents.map((a) => (
                <tr key={a.agentId} className="border-b border-border last:border-0">
                  <td className="px-card-padding py-2 font-mono text-ink-primary">{a.agentId}</td>
                  <td className="px-card-padding py-2">
                    <StatusPill tone={a.status === "online" ? "good" : "muted"}>{a.status}</StatusPill>
                  </td>
                  <td className="px-card-padding py-2 font-mono text-xs text-ink-secondary">{a.version ?? "—"}</td>
                  <td className="px-card-padding py-2">
                    {a.updateStatus === "up_to_date" && <StatusPill tone="good">Up to date</StatusPill>}
                    {a.updateStatus === "pending" && <StatusPill tone="warning">Update pending</StatusPill>}
                    {a.updateStatus === "unknown" && <StatusPill tone="muted">Unknown</StatusPill>}
                  </td>
                </tr>
              ))}
              {data && data.agents.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-card-padding py-6 text-center text-sm text-ink-muted">
                    No devices registered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

export default function AgentUpdatesPage() {
  return <AuthGate>{(username) => <AgentUpdates username={username} />}</AuthGate>;
}
