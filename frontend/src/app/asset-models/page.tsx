"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { AssetModelFormModal } from "@/components/assetModels/AssetModelFormModal";
import { ApiError, getAssetModels, deleteAssetModel } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetModel } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function AssetModels({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [models, setModels] = useState<AssetModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssetModel | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getAssetModels()
      .then((res) => setModels(res.assetModels))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load asset models.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteAssetModel(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete asset model."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">category</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Asset Models</h1>
              <p className="text-xs text-ink-muted">Reusable templates that prefill common asset fields when registering a new asset.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
              New asset model
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : models === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : models.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No asset models yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Category", "Manufacturer / Model", "Depreciation", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {models.map((m) => (
                  <tr key={m.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{m.name}</td>
                    <td className="p-4 text-sm text-ink-secondary">{m.category || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{[m.manufacturer, m.model].filter(Boolean).join(" ") || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{m.depreciationYears ? `${m.depreciationYears} yr` : "—"}</td>
                    <td className="p-4 text-right">
                      {canWrite && (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" icon="edit" onClick={() => setEditing(m)}>
                            Edit
                          </Button>
                          <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(m)}>
                            Delete
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

      {editing && (
        <AssetModelFormModal
          editing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.name}"?`}
        message="This can't be undone. Asset models used by existing assets can't be deleted."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function AssetModelsPage() {
  return <AuthGate>{(username) => <AssetModels username={username} />}</AuthGate>;
}
