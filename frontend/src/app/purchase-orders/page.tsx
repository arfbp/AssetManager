"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { PurchaseOrderFormModal } from "@/components/procurement/PurchaseOrderFormModal";
import { ApiError, getPurchaseOrders, approvePurchaseOrder, rejectPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, deletePurchaseOrder } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import { toCsv } from "@/lib/csv";
import type { PurchaseOrder, PurchaseOrderStatus } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  received: "Received",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<PurchaseOrderStatus, string> = {
  draft: "bg-gridline text-ink-muted",
  pending_approval: "bg-status-warning/10 text-status-warning",
  approved: "bg-status-good/10 text-status-good",
  rejected: "bg-status-critical/10 text-status-critical",
  received: "bg-accent/10 text-accent",
  cancelled: "bg-gridline text-ink-muted",
};

function exportCsv(orders: PurchaseOrder[]): void {
  const rows: string[][] = [["PO Number", "Vendor", "Status", "Order Date", "Total Cost", "Requested By"]];
  for (const po of orders) {
    rows.push([po.poNumber, po.vendorName, STATUS_LABEL[po.status], po.orderDate ?? "", po.totalCost.toFixed(2), po.requestedBy]);
  }
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "purchase-orders.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function PurchaseOrders({ username }: { username: string }) {
  const role = getStoredRole();
  const canWrite = role !== "viewer";
  const isAdmin = role === "admin";
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PurchaseOrder | null>(null);

  function reload(): void {
    getPurchaseOrders()
      .then((res) => setOrders(res.purchaseOrders))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load purchase orders.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleAction(id: string, fn: (id: string) => Promise<unknown>): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await fn(id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Action failed."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReceive(po: PurchaseOrder): Promise<void> {
    setBusyId(po.id);
    setActionError(null);
    try {
      const res = await receivePurchaseOrder(po.id, { createAssets: true });
      if (res.createdAssetTags.length > 0) {
        setActionError(null);
      }
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to receive purchase order."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deletePurchaseOrder(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete purchase order."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">receipt_long</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Purchase Orders</h1>
              <p className="text-xs text-ink-muted">Requested, approved, and received orders from your vendors.</p>
            </div>
          </div>
          <div className="flex gap-2">
            {orders && orders.length > 0 && (
              <Button variant="secondary" icon="download" onClick={() => exportCsv(orders)}>
                Export CSV
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" icon="add" onClick={() => setShowCreate(true)}>
                New purchase order
              </Button>
            )}
          </div>
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : orders === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : orders.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No purchase orders yet.</p>
          ) : (
            <div className="divide-y divide-gridline">
              {orders.map((po) => (
                <div key={po.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <button type="button" onClick={() => setExpanded(expanded === po.id ? null : po.id)} className="flex flex-1 items-center gap-3 text-left">
                      <span className="material-symbols-outlined text-[18px] text-ink-muted">{expanded === po.id ? "expand_less" : "expand_more"}</span>
                      <div>
                        <p className="text-sm font-bold text-ink-primary">
                          {po.poNumber} — {po.vendorName}
                        </p>
                        <p className="text-xs text-ink-muted">
                          ${po.totalCost.toFixed(2)} · {po.items.length} item(s) · requested by {po.requestedBy}
                        </p>
                      </div>
                    </button>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[po.status]}`}>{STATUS_LABEL[po.status]}</span>
                    <div className="flex gap-2">
                      {isAdmin && po.status === "pending_approval" && (
                        <>
                          <Button variant="primary" onClick={() => handleAction(po.id, approvePurchaseOrder)} disabled={busyId === po.id}>
                            Approve
                          </Button>
                          <Button variant="danger" onClick={() => handleAction(po.id, rejectPurchaseOrder)} disabled={busyId === po.id}>
                            Reject
                          </Button>
                        </>
                      )}
                      {canWrite && po.status === "approved" && (
                        <Button variant="primary" icon="inventory" onClick={() => handleReceive(po)} disabled={busyId === po.id}>
                          Receive & create assets
                        </Button>
                      )}
                      {canWrite && (po.status === "pending_approval" || po.status === "approved") && (
                        <Button variant="secondary" onClick={() => handleAction(po.id, cancelPurchaseOrder)} disabled={busyId === po.id}>
                          Cancel
                        </Button>
                      )}
                      {canWrite && po.status !== "approved" && po.status !== "received" && (
                        <Button variant="ghost" icon="delete" onClick={() => setDeleteTarget(po)} disabled={busyId === po.id} />
                      )}
                    </div>
                  </div>

                  {expanded === po.id && (
                    <div className="mt-3 ml-7 rounded-md border border-border bg-page p-3">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="text-ink-muted">
                            <th className="pb-1">Description</th>
                            <th className="pb-1">Category</th>
                            <th className="pb-1 text-right">Qty</th>
                            <th className="pb-1 text-right">Unit cost</th>
                            <th className="pb-1 text-right">Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {po.items.map((item) => (
                            <tr key={item.id} className="text-ink-secondary">
                              <td className="py-0.5">{item.description}</td>
                              <td className="py-0.5">{item.assetCategory || "—"}</td>
                              <td className="py-0.5 text-right">{item.quantity}</td>
                              <td className="py-0.5 text-right">${item.unitCost.toFixed(2)}</td>
                              <td className="py-0.5 text-right">${(item.quantity * item.unitCost).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {po.notes && <p className="mt-2 text-xs text-ink-muted">Notes: {po.notes}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {showCreate && (
        <PurchaseOrderFormModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.poNumber}"?`}
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

export default function PurchaseOrdersPage() {
  return <AuthGate>{(username) => <PurchaseOrders username={username} />}</AuthGate>;
}
