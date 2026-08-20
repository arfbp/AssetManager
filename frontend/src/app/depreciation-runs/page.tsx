"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, getDepreciationRuns, calculateDepreciationRun, postDepreciationRun, reverseDepreciationRun } from "@/lib/api";
import type { DepreciationRun } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const STATUS_TONE: Record<DepreciationRun["status"], string> = {
  draft: "bg-status-warning/10 text-status-warning",
  posted: "bg-status-good/10 text-status-good",
  reversed: "bg-gridline text-ink-muted",
};

function DepreciationRuns({ username }: { username: string }) {
  const [runs, setRuns] = useState<DepreciationRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const now = new Date();
  const [fiscalYear, setFiscalYear] = useState(String(now.getFullYear()));
  const [period, setPeriod] = useState(String(now.getMonth() + 1));

  function reload(): void {
    getDepreciationRuns()
      .then((res) => setRuns(res.runs))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load depreciation runs.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleCalculate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setActionError(null);
    try {
      await calculateDepreciationRun({ fiscalYear: Number(fiscalYear), period: period ? Number(period) : null });
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to calculate run."));
    }
  }

  async function handlePost(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await postDepreciationRun(id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to post run."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReverse(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await reverseDepreciationRun(id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to reverse run."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">calculate</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Depreciation Runs</h1>
            <p className="text-xs text-ink-muted">Calculate a period's straight-line depreciation, then post it to the ledger.</p>
          </div>
        </div>

        <Panel className="p-4">
          <form onSubmit={handleCalculate} className="flex items-end gap-2">
            <label className="text-xs text-ink-secondary">
              Fiscal year
              <input type="number" value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} className="mt-1 w-28 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
            <label className="text-xs text-ink-secondary">
              Month (1–12, blank = annual)
              <input type="number" min={1} max={12} value={period} onChange={(e) => setPeriod(e.target.value)} className="mt-1 w-40 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
            <Button type="submit" variant="primary" icon="calculate">
              Calculate run
            </Button>
          </form>
        </Panel>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : runs === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No depreciation runs yet.</p>
          ) : (
            <div className="divide-y divide-gridline">
              {runs.map((r) => (
                <div key={r.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <button type="button" onClick={() => setExpanded(expanded === r.id ? null : r.id)} className="flex flex-1 items-center gap-3 text-left">
                      <span className="material-symbols-outlined text-[18px] text-ink-muted">{expanded === r.id ? "expand_less" : "expand_more"}</span>
                      <div>
                        <p className="text-sm font-bold text-ink-primary">
                          {r.fiscalYear}
                          {r.period ? `-${String(r.period).padStart(2, "0")}` : " (annual)"}
                        </p>
                        <p className="text-xs text-ink-muted">
                          ${r.totalAmount.toFixed(2)} · {r.lines.length} asset(s)
                        </p>
                      </div>
                    </button>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>{r.status}</span>
                    {r.status === "draft" && (
                      <Button variant="primary" onClick={() => handlePost(r.id)} disabled={busyId === r.id}>
                        Post
                      </Button>
                    )}
                    {r.status === "posted" && (
                      <Button variant="secondary" onClick={() => handleReverse(r.id)} disabled={busyId === r.id}>
                        Reverse
                      </Button>
                    )}
                  </div>

                  {expanded === r.id && (
                    <div className="mt-3 ml-7 rounded-md border border-border bg-page p-3">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="text-ink-muted">
                            <th className="pb-1">Asset</th>
                            <th className="pb-1 text-right">Amount</th>
                            <th className="pb-1 text-right">Book value before</th>
                            <th className="pb-1 text-right">Book value after</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.lines.map((l) => (
                            <tr key={l.id} className="text-ink-secondary">
                              <td className="py-0.5">{l.assetTag}</td>
                              <td className="py-0.5 text-right">${l.amount.toFixed(2)}</td>
                              <td className="py-0.5 text-right">${l.bookValueBefore.toFixed(2)}</td>
                              <td className="py-0.5 text-right">${l.bookValueAfter.toFixed(2)}</td>
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

export default function DepreciationRunsPage() {
  return <AuthGate>{(username) => <DepreciationRuns username={username} />}</AuthGate>;
}
