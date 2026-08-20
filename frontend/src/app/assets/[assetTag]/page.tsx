"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { AssetRequestModal } from "@/components/assetRequests/AssetRequestModal";
import { MaintenanceFormModal } from "@/components/maintenance/MaintenanceFormModal";
import { RetireAssetModal } from "@/components/accounting/RetireAssetModal";
import { HandoverFormModal } from "@/components/handovers/HandoverFormModal";
import {
  ApiError,
  getAssets,
  checkinAsset,
  getAssetHistory,
  getMaintenanceRecords,
  getLicenses,
  getAccumulatedDepreciation,
  getJournalEntries,
  getEmployees,
} from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetHistoryEvent, AssetWithLiveInfo, MaintenanceRecord, SoftwareLicense, JournalEntry, Employee } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

type Tab = "overview" | "history" | "maintenance" | "licenses" | "accounting";

const HISTORY_ICON: Record<AssetHistoryEvent["kind"], string> = {
  handover_out: "logout",
  handover_returned: "login",
  maintenance_scheduled: "event",
  maintenance_completed: "task_alt",
  connection: "cable",
  transfer: "sync_alt",
  adjustment: "tune",
  retirement: "archive",
};

function AssetDetail({ username, assetTag }: { username: string; assetTag: string }) {
  const router = useRouter();
  const canWrite = getStoredRole() !== "viewer";
  // GET /journal-entries ฝั่ง server จำกัดให้ admin เท่านั้น (เป็นข้อมูล
  // accounting จริง เข้มกว่า split admin/it_support ของ ERP ปกติ) เลยแค่ไม่
  // render tab Accounting ให้ role อื่นเห็นไปเลย ดีกว่าให้ tab เดียวกันมี
  // เนื้อหาต่างกันตาม role แบบเงียบ ๆ
  const isAdmin = getStoredRole() === "admin";
  const [asset, setAsset] = useState<AssetWithLiveInfo | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("overview");
  const [history, setHistory] = useState<AssetHistoryEvent[] | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceRecord[] | null>(null);
  const [licenses, setLicenses] = useState<SoftwareLicense[] | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[] | null>(null);
  const [showRequest, setShowRequest] = useState(false);
  const [showScheduleMaintenance, setShowScheduleMaintenance] = useState(false);
  const [showRetire, setShowRetire] = useState(false);
  const [showHandover, setShowHandover] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accumulatedDepreciation, setAccumulatedDepreciation] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    getAssets()
      .then((res) => setAsset(res.assets.find((a) => a.assetTag === assetTag) ?? null))
      .catch((err) => setError(errorMessage(err, "Couldn't load this asset.")));
    getAccumulatedDepreciation(assetTag)
      .then((res) => setAccumulatedDepreciation(res.accumulatedDepreciation))
      .catch(() => setAccumulatedDepreciation(null));
  }

  useEffect(() => {
    reload();
    getEmployees()
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetTag]);

  useEffect(() => {
    if (tab === "history" && history === null) {
      getAssetHistory(assetTag)
        .then((res) => setHistory(res.events))
        .catch(() => setHistory([]));
    }
    if (tab === "maintenance" && maintenance === null) {
      getMaintenanceRecords(assetTag)
        .then((res) => setMaintenance(res.records))
        .catch(() => setMaintenance([]));
    }
    if (tab === "licenses" && licenses === null) {
      getLicenses()
        .then((res) => setLicenses(res.licenses.filter((l) => l.assignments.some((a) => a.assetTag === assetTag))))
        .catch(() => setLicenses([]));
    }
    if (tab === "accounting" && journalEntries === null) {
      getJournalEntries(undefined, assetTag)
        .then((res) => setJournalEntries(res.entries))
        .catch(() => setJournalEntries([]));
    }
  }, [tab, assetTag, history, maintenance, licenses, journalEntries]);

  async function handleCheckin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await checkinAsset(assetTag);
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to check in asset."));
    } finally {
      setBusy(false);
    }
  }

  if (asset === undefined) {
    return (
      <AppShell username={username}>
        <p className="p-6 text-sm text-ink-muted">Loading…</p>
      </AppShell>
    );
  }
  if (asset === null) {
    return (
      <AppShell username={username}>
        <p className="p-6 text-sm text-status-critical">Asset "{assetTag}" not found.</p>
      </AppShell>
    );
  }

  const isCheckedOut = Boolean(asset.checkedOutTo);

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">inventory_2</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">{asset.assetTag}</h1>
              <p className="text-xs text-ink-muted">{[asset.manufacturer, asset.model].filter(Boolean).join(" ") || asset.category || "Asset"}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={`/assets/${encodeURIComponent(assetTag)}/label/print`}>
              <Button variant="secondary" icon="qr_code_2">
                Print QR label
              </Button>
            </Link>
            {canWrite && isCheckedOut && (
              <Button variant="primary" icon="assignment_return" onClick={handleCheckin} disabled={busy}>
                Check in
              </Button>
            )}
            {canWrite && !isCheckedOut && asset.status !== "retired" && (
              <Button variant="secondary" icon="assignment_turned_in" onClick={() => setShowHandover(true)}>
                Hand over
              </Button>
            )}
            {asset.isRequestable && !isCheckedOut && (
              <Button variant="primary" icon="pan_tool" onClick={() => setShowRequest(true)}>
                Request this asset
              </Button>
            )}
            {canWrite && asset.status !== "retired" && (
              <Button variant="danger" icon="archive" onClick={() => setShowRetire(true)}>
                Retire
              </Button>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-status-critical">{error}</p>}

        <div className="flex gap-1 border-b border-border">
          {([
            "overview",
            "history",
            "maintenance",
            "licenses",
            ...(isAdmin ? (["accounting"] as const) : []),
          ] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize ${tab === t ? "border-b-2 border-accent text-accent" : "text-ink-secondary hover:text-ink-primary"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <Panel className="p-5">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Status</p>
                <p className="text-ink-primary">{asset.status}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Location</p>
                <p className="text-ink-primary">{asset.location || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Checked out to</p>
                <p className="text-ink-primary">
                  {(() => {
                    const name = asset.checkedOutToEmployeeName ?? asset.checkedOutTo;
                    if (!name) return "—";
                    return asset.checkedOutToEmployeeId ? (
                      <Link href={`/employees/${asset.checkedOutToEmployeeId}`} className="hover:underline">
                        {name}
                      </Link>
                    ) : (
                      name
                    );
                  })()}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Serial</p>
                <p className="text-ink-primary">{asset.serialNumber || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Book value</p>
                <p className="text-ink-primary">{asset.currentBookValue !== null ? `$${asset.currentBookValue.toFixed(2)}` : "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Warranty expiry</p>
                <p className="text-ink-primary">{asset.warrantyExpiryDate ? asset.warrantyExpiryDate.slice(0, 10) : "—"}</p>
              </div>
              {accumulatedDepreciation !== null && accumulatedDepreciation > 0 && asset.purchaseCost !== null && asset.purchaseCost !== undefined && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">GL book value</p>
                  <p className="text-ink-primary">${(asset.purchaseCost - accumulatedDepreciation).toFixed(2)}</p>
                  <p className="text-[11px] text-ink-muted">Cost ${asset.purchaseCost.toFixed(2)} − accumulated depreciation ${accumulatedDepreciation.toFixed(2)}</p>
                </div>
              )}
            </div>
          </Panel>
        )}

        {tab === "overview" && (
          <Panel className="p-5">
            <h3 className="mb-3 font-semibold text-ink-primary">Purchasing</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Vendor</p>
                <p className="text-ink-primary">
                  {asset.vendorName ? (
                    <Link href="/vendors" className="hover:underline">
                      {asset.vendorName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Purchase order</p>
                <p className="text-ink-primary">
                  {asset.purchaseOrderNumber ? (
                    <Link href="/purchase-orders" className="hover:underline">
                      {asset.purchaseOrderNumber}
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Order number</p>
                <p className="text-ink-primary">{asset.orderNumber || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Asset model</p>
                <p className="text-ink-primary">{asset.assetModelName || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Purchase date</p>
                <p className="text-ink-primary">{asset.purchaseDate ? asset.purchaseDate.slice(0, 10) : "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Purchase cost</p>
                <p className="text-ink-primary">{asset.purchaseCost !== null && asset.purchaseCost !== undefined ? `$${asset.purchaseCost.toFixed(2)}` : "—"}</p>
              </div>
            </div>
          </Panel>
        )}

        {tab === "history" && (
          <Panel className="p-5">
            {history === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-ink-muted">No history yet.</p>
            ) : (
              <ul className="space-y-3">
                {history.map((ev, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="material-symbols-outlined mt-0.5 text-[18px] text-ink-muted">{HISTORY_ICON[ev.kind]}</span>
                    <div>
                      <p className="text-sm text-ink-primary">{ev.summary}</p>
                      <p className="text-xs text-ink-muted">{new Date(ev.at).toLocaleString()}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === "maintenance" && (
          <Panel className="p-5">
            <div className="mb-3 flex justify-end">
              {canWrite && (
                <Button variant="primary" icon="add" onClick={() => setShowScheduleMaintenance(true)}>
                  Schedule maintenance
                </Button>
              )}
            </div>
            {maintenance === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : maintenance.length === 0 ? (
              <p className="text-sm text-ink-muted">No maintenance records yet.</p>
            ) : (
              <ul className="space-y-2">
                {maintenance.map((m) => (
                  <li key={m.id} className="rounded-md border border-border p-3 text-sm">
                    <p className="text-ink-primary">{m.description}</p>
                    <p className="text-xs text-ink-muted">
                      {m.status} {m.scheduledDate ? `· scheduled ${m.scheduledDate.slice(0, 10)}` : ""} {m.completedDate ? `· completed ${m.completedDate.slice(0, 10)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === "licenses" && (
          <Panel className="p-5">
            {licenses === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : licenses.length === 0 ? (
              <p className="text-sm text-ink-muted">No licenses assigned to this asset. Assign one from the Licenses page.</p>
            ) : (
              <ul className="space-y-2">
                {licenses.map((l) => (
                  <li key={l.id} className="rounded-md border border-border p-3 text-sm">
                    <p className="text-ink-primary">{l.name}</p>
                    <p className="text-xs text-ink-muted">{l.vendorName || "No vendor"} {l.expiryDate ? `· expires ${l.expiryDate.slice(0, 10)}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === "accounting" && isAdmin && (
          <Panel className="p-5">
            {journalEntries === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : journalEntries.length === 0 ? (
              <div className="text-sm text-ink-muted">
                <p>No journal entries posted for this asset yet.</p>
                <p className="mt-1 text-xs">
                  Depreciation is posted per run, not per asset — see accumulated depreciation on the Overview tab.
                </p>
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {journalEntries.map((entry) => (
                    <li key={entry.id} className="rounded-md border border-border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-ink-primary">{entry.description}</p>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-ink-secondary">{entry.source.replace(/_/g, " ")}</span>
                          {entry.status === "reversed" && (
                            <span className="rounded-full bg-status-critical/10 px-2 py-0.5 text-[11px] font-medium text-status-critical">Reversed</span>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-ink-muted">
                        {entry.entryDate.slice(0, 10)} · ${entry.totalDebit.toFixed(2)}
                      </p>
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {entry.lines.map((line) => (
                          <li key={line.id} className="flex items-center justify-between text-xs text-ink-secondary">
                            <span>{line.accountCode} {line.accountName}</span>
                            <span className="tabular-nums">{line.debit > 0 ? `Dr $${line.debit.toFixed(2)}` : `Cr $${line.credit.toFixed(2)}`}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
                <Link href="/journal-entries" className="mt-3 inline-block text-xs text-accent hover:underline">
                  View full ledger
                </Link>
              </>
            )}
          </Panel>
        )}
      </div>

      {showRequest && (
        <AssetRequestModal
          assetTag={assetTag}
          onClose={() => setShowRequest(false)}
          onRequested={() => {
            setShowRequest(false);
            router.push("/asset-requests");
          }}
        />
      )}

      {showScheduleMaintenance && (
        <MaintenanceFormModal
          assets={[asset]}
          prefill={{ assetTag }}
          onClose={() => setShowScheduleMaintenance(false)}
          onSaved={() => {
            setShowScheduleMaintenance(false);
            setMaintenance(null);
          }}
        />
      )}

      {showRetire && (
        <RetireAssetModal
          assetTag={assetTag}
          onClose={() => setShowRetire(false)}
          onRetired={() => {
            setShowRetire(false);
            reload();
            setHistory(null);
            setJournalEntries(null);
          }}
        />
      )}

      {showHandover && (
        <HandoverFormModal
          assets={[asset]}
          employees={employees}
          prefill={{ assetTag }}
          onClose={() => setShowHandover(false)}
          onCreated={() => {
            setShowHandover(false);
            reload();
            setHistory(null);
          }}
        />
      )}
    </AppShell>
  );
}

export default function AssetDetailPage() {
  const params = useParams<{ assetTag: string }>();
  return <AuthGate>{(username) => <AssetDetail username={username} assetTag={decodeURIComponent(params.assetTag)} />}</AuthGate>;
}
