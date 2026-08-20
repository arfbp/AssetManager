"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, getCountCycles, startCountCycle } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetCountCycle } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function AssetCounts({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [cycles, setCycles] = useState<AssetCountCycle[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    getCountCycles()
      .then((res) => setCycles(res.cycles))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load count cycles.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await startCountCycle(name.trim(), dueDate || null);
      setShowCreate(false);
      setName("");
      setDueDate("");
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to start count cycle."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">checklist</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Asset Counting</h1>
              <p className="text-xs text-ink-muted">Periodic physical-verification cycles — every active asset gets a line to check off.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setShowCreate(true)}>
              New count cycle
            </Button>
          )}
        </div>

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : cycles === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : cycles.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No count cycles yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Started", "Due", "Progress", "Discrepancies", "Status"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {cycles.map((c) => (
                  <tr key={c.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">
                      <Link href={`/asset-counts/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{c.startedAt.slice(0, 10)}</td>
                    <td className="p-4 text-sm text-ink-secondary">{c.dueDate ? c.dueDate.slice(0, 10) : "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">
                      {c.countedLines}/{c.totalLines}
                    </td>
                    <td className="p-4 text-sm">{c.discrepancyLines > 0 ? <span className="text-status-critical">{c.discrepancyLines}</span> : "0"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.status === "closed" ? "bg-gridline text-ink-muted" : "bg-status-warning/10 text-status-warning"}`}>
                        {c.status === "closed" ? "Closed" : "Open"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button type="button" aria-label="Dismiss" onClick={() => setShowCreate(false)} className="absolute inset-0 bg-black/40" />
          <form onSubmit={handleCreate} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-ink-primary">New count cycle</h2>
            <p className="mt-1 text-xs text-ink-muted">Creates one line per active asset for staff to check off.</p>
            <label className="mt-4 block text-xs text-ink-secondary">
              Name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="e.g. Q1 2026 Inventory Audit" className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="mt-2 block text-xs text-ink-secondary">
              Due date
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
                Cancel
              </button>
              <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                {busy ? "Starting…" : "Start cycle"}
              </button>
            </div>
          </form>
        </div>
      )}
    </AppShell>
  );
}

export default function AssetCountsPage() {
  return <AuthGate>{(username) => <AssetCounts username={username} />}</AuthGate>;
}
