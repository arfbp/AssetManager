"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { ApiError, getAssetRetirements } from "@/lib/api";
import type { AssetRetirement } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function AssetRetirements({ username }: { username: string }) {
  const [retirements, setRetirements] = useState<AssetRetirement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getAssetRetirements()
      .then((res) => setRetirements(res.retirements))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load retirements.")));
  }, []);

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">archive</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Asset Retirements</h1>
            <p className="text-xs text-ink-muted">Formal disposal records — retire an asset from its own detail page.</p>
          </div>
        </div>

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : retirements === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : retirements.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No retirements yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Reason", "Disposal method", "Proceeds", "Date", "GL"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {retirements.map((r) => (
                  <tr key={r.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{r.assetTag}</td>
                    <td className="p-4 text-sm capitalize text-ink-secondary">{r.reason}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.disposalMethod || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.proceeds !== null ? `$${r.proceeds.toFixed(2)}` : "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.retirementDate.slice(0, 10)}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.journalEntryId ? "Posted" : "—"}</td>
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

export default function AssetRetirementsPage() {
  return <AuthGate>{(username) => <AssetRetirements username={username} />}</AuthGate>;
}
