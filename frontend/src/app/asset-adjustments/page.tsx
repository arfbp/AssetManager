"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { AssetAdjustmentFormModal } from "@/components/accounting/AssetAdjustmentFormModal";
import { ApiError, getAssetAdjustments, getAssets } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetAdjustment, AssetWithLiveInfo } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function AssetAdjustments({ username }: { username: string }) {
  const canWrite = getStoredRole() === "admin";
  const [adjustments, setAdjustments] = useState<AssetAdjustment[] | null>(null);
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function reload(): void {
    Promise.all([getAssetAdjustments(), getAssets()])
      .then(([adj, a]) => {
        setAdjustments(adj.adjustments);
        setAssets(a.assets);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load adjustments.")));
  }

  useEffect(() => {
    reload();
  }, []);

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">tune</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Asset Adjustments</h1>
              <p className="text-xs text-ink-muted">A recorded, reasoned log of value/useful-life changes — cost adjustments post a balancing GL entry.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setShowCreate(true)}>
              New adjustment
            </Button>
          )}
        </div>

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : adjustments === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : adjustments.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No adjustments yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Field", "Change", "Reason", "Date", "GL"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{a.assetTag}</td>
                    <td className="p-4 text-sm capitalize text-ink-secondary">{a.fieldChanged.replace(/_/g, " ")}</td>
                    <td className="p-4 text-sm text-ink-secondary">
                      {a.oldValue ?? "—"} → {a.newValue ?? "—"}
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{a.reason || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{a.adjustmentDate.slice(0, 10)}</td>
                    <td className="p-4 text-sm text-ink-secondary">{a.journalEntryId ? "Posted" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {showCreate && (
        <AssetAdjustmentFormModal
          assets={assets}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            reload();
          }}
        />
      )}
    </AppShell>
  );
}

export default function AssetAdjustmentsPage() {
  return <AuthGate>{(username) => <AssetAdjustments username={username} />}</AuthGate>;
}
