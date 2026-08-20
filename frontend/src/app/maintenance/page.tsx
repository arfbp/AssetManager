"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { MaintenanceFormModal } from "@/components/maintenance/MaintenanceFormModal";
import { ApiError, getMaintenanceRecords, getAssets, completeMaintenanceRecord, deleteMaintenanceRecord } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetWithLiveInfo, MaintenanceRecord } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Maintenance({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [records, setRecords] = useState<MaintenanceRecord[] | null>(null);
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MaintenanceRecord | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaintenanceRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    Promise.all([getMaintenanceRecords(), getAssets()])
      .then(([m, a]) => {
        setRecords(m.records);
        setAssets(a.assets);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load maintenance records.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleComplete(record: MaintenanceRecord): Promise<void> {
    setBusyId(record.id);
    setActionError(null);
    try {
      await completeMaintenanceRecord(record.id, {});
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to mark complete."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deleteMaintenanceRecord(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete record."));
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
              <span className="material-symbols-outlined text-[24px]">build</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Maintenance & Warranty</h1>
              <p className="text-xs text-ink-muted">Scheduled service, repairs, and inspections across your fleet.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
              Schedule maintenance
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : records === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : records.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No maintenance records yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Type", "Description", "Scheduled", "Status", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {records.map((r) => (
                  <tr key={r.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{r.assetTag}</td>
                    <td className="p-4 text-sm capitalize text-ink-secondary">{r.type}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.description}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.scheduledDate ? r.scheduledDate.slice(0, 10) : "—"}</td>
                    <td className="p-4">
                      {r.status === "completed" ? (
                        <span className="rounded-full bg-status-good/10 px-2 py-0.5 text-xs font-medium text-status-good">Completed</span>
                      ) : r.status === "cancelled" ? (
                        <span className="rounded-full bg-gridline px-2 py-0.5 text-xs font-medium text-ink-muted">Cancelled</span>
                      ) : r.overdue ? (
                        <span className="rounded-full bg-status-critical/10 px-2 py-0.5 text-xs font-medium text-status-critical">Overdue</span>
                      ) : (
                        <span className="rounded-full bg-status-warning/10 px-2 py-0.5 text-xs font-medium text-status-warning">Scheduled</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      {canWrite && (
                        <div className="flex justify-end gap-2">
                          {r.status === "scheduled" && (
                            <Button variant="primary" onClick={() => handleComplete(r)} disabled={busyId === r.id}>
                              Mark complete
                            </Button>
                          )}
                          <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(r)} disabled={busyId === r.id} />
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

      {editing && (
        <MaintenanceFormModal
          editing={editing === "new" ? null : editing}
          assets={assets}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this maintenance record?"
        message="This can't be undone."
        confirmLabel="Delete"
        tone="danger"
        busy={busyId === deleteTarget?.id}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function MaintenancePage() {
  return <AuthGate>{(username) => <Maintenance username={username} />}</AuthGate>;
}
