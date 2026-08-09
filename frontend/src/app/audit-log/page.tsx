"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { ApiError, getAuditEvents, type AuditEvent } from "@/lib/api";
import { getStoredIsPlatformAdmin } from "@/lib/session";

const PAGE_SIZE = 50;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// action strings are dot-namespaced ("org.created", "org.status_changed",
// ...) from server/src/api/routes.ts's recordAuditEvent calls — this just
// turns them into something readable without needing a lookup table kept
// in sync with every call site.
function formatAction(action: string): string {
  return action
    .split(".")
    .pop()!
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function orgLabel(event: AuditEvent): string {
  const orgName = event.details && typeof event.details.orgName === "string" ? event.details.orgName : null;
  if (orgName) return orgName;
  if (event.orgId) return event.orgId;
  return "—";
}

function AuditLog({ username }: { username: string }) {
  const isPlatformAdmin = getStoredIsPlatformAdmin();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  function reload(newOffset: number): void {
    getAuditEvents({ limit: PAGE_SIZE, offset: newOffset })
      .then((res) => {
        setEvents(res.events);
        setTotal(res.total);
        setOffset(newOffset);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load the audit log.")));
  }

  useEffect(() => {
    if (isPlatformAdmin) reload(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isPlatformAdmin) {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">history</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Audit Log</h1>
            <p className="text-xs text-ink-muted">Platform-admin actions across every organization — org creation, suspension, deletion, and support tooling.</p>
          </div>
        </div>

        <div className="glass-card overflow-hidden rounded-xl">
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : events === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : events.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No platform-admin actions recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gridline/30">
                  <tr>
                    {["Time", "Actor", "Action", "Organization", "Details"].map((h) => (
                      <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gridline">
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td className="whitespace-nowrap p-4 text-xs text-ink-muted">{new Date(event.createdAt).toLocaleString()}</td>
                      <td className="p-4 text-sm font-medium text-ink-primary">{event.actorUsername}</td>
                      <td className="p-4 text-sm text-ink-secondary">{formatAction(event.action)}</td>
                      <td className="p-4 text-xs text-ink-muted">{orgLabel(event)}</td>
                      <td className="max-w-[360px] p-4 font-mono text-[11px] text-ink-muted">
                        {event.details ? JSON.stringify(event.details) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {events !== null && events.length > 0 && (
          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!canPrev}
                onClick={() => reload(Math.max(0, offset - PAGE_SIZE))}
                className="rounded-md border border-border px-3 py-1.5 font-medium text-ink-secondary hover:bg-gridline/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!canNext}
                onClick={() => reload(offset + PAGE_SIZE)}
                className="rounded-md border border-border px-3 py-1.5 font-medium text-ink-secondary hover:bg-gridline/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function AuditLogPage() {
  return <AuthGate>{(username) => <AuditLog username={username} />}</AuthGate>;
}
