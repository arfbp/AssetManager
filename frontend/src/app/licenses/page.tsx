"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { LicenseFormModal } from "@/components/licenses/LicenseFormModal";
import { ApiError, getLicenses, deleteLicense, assignLicense, unassignLicense, getAssets } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetWithLiveInfo, SoftwareLicense } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function isExpiringSoon(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  return new Date(expiryDate).getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000;
}

function Licenses({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const [licenses, setLicenses] = useState<SoftwareLicense[] | null>(null);
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SoftwareLicense | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SoftwareLicense | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assignAssetTag, setAssignAssetTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    Promise.all([getLicenses(), getAssets()])
      .then(([l, a]) => {
        setLicenses(l.licenses);
        setAssets(a.assets);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load licenses.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleAssign(licenseId: string): Promise<void> {
    if (!assignAssetTag) return;
    setBusy(true);
    setActionError(null);
    try {
      await assignLicense(licenseId, assignAssetTag);
      setAssignAssetTag("");
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to assign license."));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnassign(licenseId: string, assetTag: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await unassignLicense(licenseId, assetTag);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to unassign license."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteLicense(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete license."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">key</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Software Licenses</h1>
              <p className="text-xs text-ink-muted">Seats, expiry, and which assets a license is assigned to.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
              New license
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : licenses === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : licenses.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No software licenses yet.</p>
          ) : (
            <div className="divide-y divide-gridline">
              {licenses.map((lic) => (
                <div key={lic.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <button type="button" onClick={() => setExpanded(expanded === lic.id ? null : lic.id)} className="flex flex-1 items-center gap-3 text-left">
                      <span className="material-symbols-outlined text-[18px] text-ink-muted">{expanded === lic.id ? "expand_less" : "expand_more"}</span>
                      <div>
                        <p className="text-sm font-bold text-ink-primary">{lic.name}</p>
                        <p className="text-xs text-ink-muted">
                          {lic.vendorName || "No vendor"} · {lic.seatsUsed}
                          {lic.seats !== null ? `/${lic.seats}` : ""} seats used
                          {lic.expiryDate && (
                            <span className={isExpiringSoon(lic.expiryDate) ? "text-status-critical" : ""}> · expires {lic.expiryDate.slice(0, 10)}</span>
                          )}
                        </p>
                      </div>
                    </button>
                    {canWrite && (
                      <div className="flex gap-2">
                        <Button variant="secondary" icon="edit" onClick={() => setEditing(lic)}>
                          Edit
                        </Button>
                        <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(lic)} />
                      </div>
                    )}
                  </div>

                  {expanded === lic.id && (
                    <div className="mt-3 ml-7 rounded-md border border-border bg-page p-3">
                      {lic.assignments.length === 0 ? (
                        <p className="text-xs text-ink-muted">Not assigned to any asset yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {lic.assignments.map((a) => (
                            <li key={a.id} className="flex items-center justify-between text-xs text-ink-secondary">
                              <span>{a.assetTag}</span>
                              {canWrite && (
                                <button type="button" onClick={() => handleUnassign(lic.id, a.assetTag)} disabled={busy} className="text-status-critical hover:underline disabled:opacity-50">
                                  Unassign
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {canWrite && (
                        <div className="mt-3 flex gap-2">
                          <select
                            value={assignAssetTag}
                            onChange={(e) => setAssignAssetTag(e.target.value)}
                            className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                          >
                            <option value="">Select an asset to assign…</option>
                            {assets.map((a) => (
                              <option key={a.assetTag} value={a.assetTag}>
                                {a.assetTag}
                              </option>
                            ))}
                          </select>
                          <Button variant="secondary" onClick={() => handleAssign(lic.id)} disabled={busy || !assignAssetTag}>
                            Assign
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {editing && (
        <LicenseFormModal
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
        message="This can't be undone and removes all its assignments."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function LicensesPage() {
  return <AuthGate>{(username) => <Licenses username={username} />}</AuthGate>;
}
