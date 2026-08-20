"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApproveRequestModal } from "@/components/assetRequests/ApproveRequestModal";
import { ApiError, getAssetRequests, getEmployees, rejectAssetRequest, cancelAssetRequest } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { AssetRequest, AssetRequestStatus, Employee } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const STATUS_LABEL: Record<AssetRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<AssetRequestStatus, string> = {
  pending: "bg-status-warning/10 text-status-warning",
  approved: "bg-status-good/10 text-status-good",
  rejected: "bg-status-critical/10 text-status-critical",
  cancelled: "bg-gridline text-ink-muted",
};

function AssetRequests({ username }: { username: string }) {
  const role = getStoredRole();
  const isAdmin = role === "admin";
  const [requests, setRequests] = useState<AssetRequest[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<AssetRequest | null>(null);

  function reload(): void {
    getAssetRequests()
      .then((res) => setRequests(res.requests))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load asset requests.")));
  }

  useEffect(() => {
    reload();
    if (isAdmin) {
      getEmployees()
        .then((res) => setEmployees(res.employees))
        .catch(() => setEmployees([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">fact_check</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Asset Requests</h1>
            <p className="text-xs text-ink-muted">Self-service requests for requestable assets — request from an asset's detail page.</p>
          </div>
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : requests === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : requests.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No asset requests yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Requested by", "Note", "Status", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">
                      <Link href={`/assets/${encodeURIComponent(r.assetTag)}`} className="hover:underline">
                        {r.assetTag}
                      </Link>
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{r.requestedBy}</td>
                    <td className="p-4 text-sm text-ink-secondary">{r.note || "—"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        {isAdmin && r.status === "pending" && (
                          <>
                            <Button variant="primary" onClick={() => setApproveTarget(r)} disabled={busyId === r.id}>
                              Approve
                            </Button>
                            <Button variant="danger" onClick={() => handleAction(r.id, rejectAssetRequest)} disabled={busyId === r.id}>
                              Reject
                            </Button>
                          </>
                        )}
                        {r.requestedBy === username && r.status === "pending" && (
                          <Button variant="secondary" onClick={() => handleAction(r.id, cancelAssetRequest)} disabled={busyId === r.id}>
                            Cancel
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

      {approveTarget && (
        <ApproveRequestModal
          request={approveTarget}
          employees={employees}
          onClose={() => setApproveTarget(null)}
          onApproved={() => {
            setApproveTarget(null);
            reload();
          }}
        />
      )}
    </AppShell>
  );
}

export default function AssetRequestsPage() {
  return <AuthGate>{(username) => <AssetRequests username={username} />}</AuthGate>;
}
