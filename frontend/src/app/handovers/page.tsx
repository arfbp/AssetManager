"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { HandoverFormModal } from "@/components/handovers/HandoverFormModal";
import { AcceptSignModal } from "@/components/handovers/AcceptSignModal";
import { ApiError, getHandovers, getAssets, getEmployees, acknowledgeHandover, getCheckoutEula } from "@/lib/api";
import { getStoredRole, getStoredOrgId } from "@/lib/session";
import type { AssetWithLiveInfo, Employee, Handover } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Handovers({ username }: { username: string }) {
  const router = useRouter();
  const canWrite = getStoredRole() !== "viewer";
  const [handovers, setHandovers] = useState<Handover[] | null>(null);
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [eulaText, setEulaText] = useState<string | null>(null);
  const [signTarget, setSignTarget] = useState<Handover | null>(null);

  function reload(): void {
    Promise.all([getHandovers(), getAssets()])
      .then(([h, a]) => {
        setHandovers(h.handovers);
        setAssets(a.assets);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load handovers.")));
    getEmployees()
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
  }

  useEffect(() => {
    reload();
    const orgId = getStoredOrgId();
    if (orgId) {
      getCheckoutEula(orgId)
        .then((res) => setEulaText(res.checkoutEulaText))
        .catch(() => setEulaText(null));
    }
  }, []);

  async function handleAcknowledge(h: Handover): Promise<void> {
    setBusyId(h.id);
    setActionError(null);
    try {
      await acknowledgeHandover(h.id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to acknowledge."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">assignment_turned_in</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Handovers</h1>
              <p className="text-xs text-ink-muted">Custody records for assets issued to employees, with a printable sign-off form.</p>
            </div>
          </div>
          {canWrite && (
            <Button variant="primary" icon="add" onClick={() => setShowCreate(true)}>
              New handover
            </Button>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : handovers === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : handovers.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No handovers yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Asset", "Employee", "Department", "Date", "Status", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {handovers.map((h) => (
                  <tr key={h.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">{h.assetTag}</td>
                    <td className="p-4 text-sm text-ink-secondary">
                      {h.employeeId ? <Link href={`/employees/${h.employeeId}`} className="hover:underline">{h.employeeName}</Link> : h.employeeName}
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{h.employeeDepartment || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{h.handoverDate.slice(0, 10)}</td>
                    <td className="p-4">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          h.status === "acknowledged" ? "bg-status-good/10 text-status-good" : "bg-status-warning/10 text-status-warning"
                        }`}
                      >
                        {h.status === "acknowledged" ? "Signed" : "Pending signature"}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" icon="print" onClick={() => router.push(`/handovers/${h.id}/print`)}>
                          Print
                        </Button>
                        {canWrite && h.status === "pending_signature" && (
                          <Button
                            variant="primary"
                            onClick={() => (eulaText ? setSignTarget(h) : handleAcknowledge(h))}
                            disabled={busyId === h.id}
                          >
                            {eulaText ? "Accept & sign" : "Mark signed"}
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

      {showCreate && (
        <HandoverFormModal
          assets={assets}
          employees={employees}
          onClose={() => setShowCreate(false)}
          onCreated={(handover) => {
            setShowCreate(false);
            reload();
            router.push(`/handovers/${handover.id}/print`);
          }}
        />
      )}

      {signTarget && eulaText && (
        <AcceptSignModal
          handover={signTarget}
          eulaText={eulaText}
          onClose={() => setSignTarget(null)}
          onSigned={() => {
            setSignTarget(null);
            reload();
          }}
        />
      )}
    </AppShell>
  );
}

export default function HandoversPage() {
  return <AuthGate>{(username) => <Handovers username={username} />}</AuthGate>;
}
