"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { GlAccountFormModal } from "@/components/accounting/GlAccountFormModal";
import { ApiError, getGlAccounts, ensureDefaultGlAccounts, deleteGlAccount } from "@/lib/api";
import type { GlAccount } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function GlAccounts({ username }: { username: string }) {
  const [accounts, setAccounts] = useState<GlAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GlAccount | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GlAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getGlAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load the chart of accounts.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleEnsureDefaults(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await ensureDefaultGlAccounts();
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to set up standard accounts."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteGlAccount(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete account."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">account_balance</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Chart of Accounts</h1>
              <p className="text-xs text-ink-muted">The accounts fixed-asset postings (acquisition, depreciation, disposal) use.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon="auto_fix_high" onClick={handleEnsureDefaults} disabled={busy}>
              Set up standard accounts
            </Button>
            <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
              New account
            </Button>
          </div>
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : accounts === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No accounts yet — click "Set up standard accounts" to get the 7 accounts fixed-asset postings need.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Code", "Name", "Type", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="p-4 font-mono text-sm text-ink-primary">{a.code}</td>
                    <td className="p-4 text-sm text-ink-primary">
                      {a.name} {a.isContra && <span className="ml-1 text-[10px] text-ink-muted">(contra)</span>}
                    </td>
                    <td className="p-4 text-sm capitalize text-ink-secondary">{a.type}</td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" icon="edit" onClick={() => setEditing(a)}>
                          Edit
                        </Button>
                        {!a.isSystem && (
                          <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(a)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {editing && (
        <GlAccountFormModal
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
        title={`Delete "${deleteTarget?.code} ${deleteTarget?.name}"?`}
        message="This can't be undone. Accounts with journal entry lines posted against them can't be deleted."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function GlAccountsPage() {
  return <AuthGate>{(username) => <GlAccounts username={username} />}</AuthGate>;
}
