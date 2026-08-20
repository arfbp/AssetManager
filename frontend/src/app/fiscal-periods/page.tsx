"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, getFiscalPeriods, openFiscalYear, closeFiscalYear } from "@/lib/api";
import type { FiscalPeriod } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function FiscalPeriods({ username }: { username: string }) {
  const [periods, setPeriods] = useState<FiscalPeriod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [yearInput, setYearInput] = useState(String(new Date().getFullYear()));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getFiscalPeriods()
      .then((res) => setPeriods(res.periods))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load fiscal periods.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleOpen(): Promise<void> {
    const year = Number(yearInput);
    if (!year) return;
    setBusy(true);
    setActionError(null);
    try {
      await openFiscalYear(year);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to open fiscal year."));
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(year: number): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await closeFiscalYear(year);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to close fiscal year."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[700px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">event_repeat</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Fiscal Periods</h1>
            <p className="text-xs text-ink-muted">A closed year rejects new journal entries dated within it — only a reversal (dated today) can undo something posted into it.</p>
          </div>
        </div>

        <Panel className="p-4">
          <div className="flex items-end gap-2">
            <label className="text-xs text-ink-secondary">
              Fiscal year
              <input
                type="number"
                value={yearInput}
                onChange={(e) => setYearInput(e.target.value)}
                className="mt-1 w-32 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              />
            </label>
            <Button variant="primary" onClick={handleOpen} disabled={busy}>
              Open year
            </Button>
          </div>
        </Panel>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : periods === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : periods.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No fiscal years opened yet — every year is implicitly open until you explicitly close one.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Year", "Status", "Closed", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {periods.map((p) => (
                  <tr key={p.fiscalYear}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{p.fiscalYear}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.status === "closed" ? "bg-gridline text-ink-muted" : "bg-status-good/10 text-status-good"}`}>
                        {p.status === "closed" ? "Closed" : "Open"}
                      </span>
                    </td>
                    <td className="p-4 text-xs text-ink-muted">{p.closedAt ? `${p.closedAt.slice(0, 10)} by ${p.closedBy}` : "—"}</td>
                    <td className="p-4 text-right">
                      {p.status === "open" && (
                        <Button variant="danger" onClick={() => handleClose(p.fiscalYear)} disabled={busy}>
                          Close year
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}

export default function FiscalPeriodsPage() {
  return <AuthGate>{(username) => <FiscalPeriods username={username} />}</AuthGate>;
}
