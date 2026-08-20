"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { AssetTransferFormModal } from "@/components/accounting/AssetTransferFormModal";
import { ApiError, getAssetTransfers, getAssets } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetTransfer, AssetWithLiveInfo } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function AssetTransfers({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [transfers, setTransfers] = useState<AssetTransfer[] | null>(null);
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function reload(): void {
    Promise.all([getAssetTransfers(), getAssets()])
      .then(([t, a]) => {
        setTransfers(t.transfers);
        setAssets(a.assets);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load transfers.")));
  }

  useEffect(() => {
    reload();
  }, []);

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">sync_alt</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Asset Transfers</h1>
              <p className="text-xs text-ink-muted">Logged moves between locations or departments.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setShowCreate(true)}>
              New transfer
            </Button>
          )}
        </div>

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : transfers === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : transfers.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No transfers yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "From", "To", "Department", "Date", "Reason"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{t.assetTag}</td>
                    <td className="p-4 text-sm text-ink-secondary">{t.fromLocation || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{t.toLocation || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{[t.fromDepartment, t.toDepartment].filter(Boolean).join(" → ") || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{t.transferDate.slice(0, 10)}</td>
                    <td className="p-4 text-sm text-ink-secondary">{t.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {showCreate && (
        <AssetTransferFormModal
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

export default function AssetTransfersPage() {
  return <AuthGate>{(username) => <AssetTransfers username={username} />}</AuthGate>;
}
