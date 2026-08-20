"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { VendorFormModal } from "@/components/vendors/VendorFormModal";
import { ApiError, getVendors, deleteVendor } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { Vendor } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Vendors({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Vendor | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getVendors()
      .then((res) => setVendors(res.vendors))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load vendors.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteVendor(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete vendor."));
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
              <span className="material-symbols-outlined text-[24px]">local_shipping</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Vendors</h1>
              <p className="text-xs text-ink-muted">Suppliers you place purchase orders with.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
              New vendor
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : vendors === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : vendors.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No vendors yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Category", "Contact", "Email", "Phone", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {vendors.map((v) => (
                  <tr key={v.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{v.name}</td>
                    <td className="p-4 text-sm text-ink-secondary">{v.category || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{v.contactName || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{v.email || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{v.phone || "—"}</td>
                    <td className="p-4 text-right">
                      {canWrite && (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" icon="edit" onClick={() => setEditing(v)}>
                            Edit
                          </Button>
                          <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(v)}>
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
        <VendorFormModal
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
        message="This can't be undone. Vendors with purchase orders on file can't be deleted."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function VendorsPage() {
  return <AuthGate>{(username) => <Vendors username={username} />}</AuthGate>;
}
