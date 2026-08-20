"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, getCountCycle, markAssetCounted, closeCountCycle } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetCountCycle, AssetCountLine } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function CountCycleDetail({ username, cycleId }: { username: string; cycleId: string }) {
  const router = useRouter();
  const canWrite = getStoredRole() !== "viewer";
  const [cycle, setCycle] = useState<AssetCountCycle | null>(null);
  const [lines, setLines] = useState<AssetCountLine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload(): void {
    getCountCycle(cycleId)
      .then((res) => {
        setCycle(res.cycle);
        setLines(res.lines);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load this count cycle.")));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId]);

  async function handleMarkCounted(line: AssetCountLine, matches: boolean): Promise<void> {
    setBusyLineId(line.id);
    setActionError(null);
    try {
      await markAssetCounted(cycleId, line.id, { actualLocation: matches ? line.expectedLocation : "" });
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to mark counted."));
    } finally {
      setBusyLineId(null);
    }
  }

  async function handleClose(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await closeCountCycle(cycleId);
      router.push("/asset-counts");
    } catch (err) {
      setActionError(errorMessage(err, "Failed to close cycle."));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <AppShell username={username}>
        <p className="p-6 text-sm text-status-critical">{loadError}</p>
      </AppShell>
    );
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">{cycle?.name ?? "Loading…"}</h1>
            <p className="text-xs text-ink-muted">
              {cycle ? `${cycle.countedLines}/${cycle.totalLines} counted · ${cycle.discrepancyLines} discrepancy(ies)` : ""}
            </p>
          </div>
          {canWrite && cycle?.status === "open" && (
            <Button variant="primary" icon="task_alt" onClick={handleClose} disabled={busy}>
              Close cycle
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {lines === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : lines.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No assets in this cycle.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Expected location", "Actual location", "Status", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{l.assetTag}</td>
                    <td className="p-4 text-sm text-ink-secondary">{l.expectedLocation || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{l.actualLocation || "—"}</td>
                    <td className="p-4">
                      {!l.counted ? (
                        <span className="text-xs text-ink-muted">Not counted</span>
                      ) : l.discrepancy ? (
                        <span className="rounded-full bg-status-critical/10 px-2 py-0.5 text-xs font-medium text-status-critical">Discrepancy</span>
                      ) : (
                        <span className="rounded-full bg-status-good/10 px-2 py-0.5 text-xs font-medium text-status-good">Verified</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      {canWrite && !l.counted && cycle?.status === "open" && (
                        <div className="flex justify-end gap-2">
                          <Button variant="primary" onClick={() => handleMarkCounted(l, true)} disabled={busyLineId === l.id}>
                            Found here
                          </Button>
                          <Button variant="danger" onClick={() => handleMarkCounted(l, false)} disabled={busyLineId === l.id}>
                            Not found
                          </Button>
                        </div>
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

export default function AssetCountCycleDetailPage() {
  const params = useParams<{ id: string }>();
  return <AuthGate>{(username) => <CountCycleDetail username={username} cycleId={params.id} />}</AuthGate>;
}
