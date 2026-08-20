"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, getJournalEntries, reverseJournalEntry } from "@/lib/api";
import type { JournalEntry } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function JournalEntries({ username }: { username: string }) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fiscalYear, setFiscalYear] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getJournalEntries(fiscalYear ? Number(fiscalYear) : undefined)
      .then((res) => setEntries(res.entries))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load journal entries.")));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiscalYear]);

  async function handleReverse(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await reverseJournalEntry(id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to reverse entry."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">receipt_long</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Journal Entries</h1>
              <p className="text-xs text-ink-muted">Every posted GL entry — acquisitions, depreciation, adjustments, disposals, and reversals.</p>
            </div>
          </div>
          <input
            value={fiscalYear}
            onChange={(e) => setFiscalYear(e.target.value)}
            placeholder="Filter by fiscal year…"
            className="w-44 rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : entries === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No journal entries yet.</p>
          ) : (
            <div className="divide-y divide-gridline">
              {entries.map((e) => (
                <div key={e.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <button type="button" onClick={() => setExpanded(expanded === e.id ? null : e.id)} className="flex flex-1 items-center gap-3 text-left">
                      <span className="material-symbols-outlined text-[18px] text-ink-muted">{expanded === e.id ? "expand_less" : "expand_more"}</span>
                      <div>
                        <p className="text-sm font-bold text-ink-primary">{e.description}</p>
                        <p className="text-xs text-ink-muted">
                          {e.entryDate.slice(0, 10)} · {e.source} · ${e.totalDebit.toFixed(2)}
                        </p>
                      </div>
                    </button>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${e.status === "reversed" ? "bg-gridline text-ink-muted" : "bg-status-good/10 text-status-good"}`}>
                      {e.status === "reversed" ? "Reversed" : "Posted"}
                    </span>
                    {e.status === "posted" && !e.source.startsWith("reversal") && (
                      <Button variant="secondary" onClick={() => handleReverse(e.id)} disabled={busyId === e.id}>
                        Reverse
                      </Button>
                    )}
                  </div>

                  {expanded === e.id && (
                    <div className="mt-3 ml-7 rounded-md border border-border bg-page p-3">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="text-ink-muted">
                            <th className="pb-1">Account</th>
                            <th className="pb-1">Memo</th>
                            <th className="pb-1 text-right">Debit</th>
                            <th className="pb-1 text-right">Credit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {e.lines.map((l) => (
                            <tr key={l.id} className="text-ink-secondary">
                              <td className="py-0.5">
                                {l.accountCode} {l.accountName}
                              </td>
                              <td className="py-0.5">{l.memo || "—"}</td>
                              <td className="py-0.5 text-right">{l.debit > 0 ? `$${l.debit.toFixed(2)}` : ""}</td>
                              <td className="py-0.5 text-right">{l.credit > 0 ? `$${l.credit.toFixed(2)}` : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}

export default function JournalEntriesPage() {
  return <AuthGate>{(username) => <JournalEntries username={username} />}</AuthGate>;
}
