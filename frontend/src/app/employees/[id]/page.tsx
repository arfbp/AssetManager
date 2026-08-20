"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { EmployeeFormModal } from "@/components/employees/EmployeeFormModal";
import { HandoverFormModal } from "@/components/handovers/HandoverFormModal";
import {
  ApiError,
  getEmployee,
  getEmployeeAssets,
  getEmployeeHistory,
  getDepartments,
  getUsers,
  getAssets,
  updateAsset,
  updateEmployee,
} from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { Employee, AssetWithLiveInfo, EmployeeHistoryEvent, Department, UserSummary } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

type Tab = "overview" | "history";

const HISTORY_ICON: Record<EmployeeHistoryEvent["kind"], string> = {
  handover_out: "logout",
  handover_returned: "login",
  request_created: "pan_tool",
  request_approved: "task_alt",
  request_rejected: "block",
  request_cancelled: "cancel",
};

function EmployeeDetail({ username, employeeId }: { username: string; employeeId: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const isAdmin = getStoredRole() === "admin";
  const [employee, setEmployee] = useState<Employee | null | undefined>(undefined);
  const [heldAssets, setHeldAssets] = useState<AssetWithLiveInfo[]>([]);
  // asset ทุกตัวในองค์กร ดึงมาแบบ lazy เพื่อใช้กับ panel "possibly this
  // employee" สำหรับ link ข้อมูล legacy เท่านั้น — ไม่เอามาโชว์ตรง ๆ
  const [allAssets, setAllAssets] = useState<AssetWithLiveInfo[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [history, setHistory] = useState<EmployeeHistoryEvent[] | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showHandover, setShowHandover] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    getEmployee(employeeId)
      .then((res) => setEmployee(res.employee))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setEmployee(null);
        } else {
          setError(errorMessage(err, "Couldn't load this employee."));
        }
      });
    getEmployeeAssets(employeeId)
      .then((res) => setHeldAssets(res.assets))
      .catch(() => setHeldAssets([]));
    getAssets()
      .then((res) => setAllAssets(res.assets))
      .catch(() => setAllAssets([]));
  }

  useEffect(() => {
    reload();
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => setDepartments([]));
    if (isAdmin) {
      getUsers()
        .then((res) => setUsers(res.users))
        .catch(() => setUsers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  useEffect(() => {
    if (tab === "history" && history === null) {
      getEmployeeHistory(employeeId)
        .then((res) => setHistory(res.events))
        .catch(() => setHistory([]));
    }
  }, [tab, employeeId, history]);

  async function handleLinkLegacyAsset(assetTag: string): Promise<void> {
    if (!employee) return;
    try {
      await updateAsset(assetTag, { checkedOutToEmployeeId: employee.id });
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to link this asset."));
    }
  }

  async function toggleStatus(): Promise<void> {
    if (!employee) return;
    try {
      await updateEmployee(employee.id, { status: employee.status === "active" ? "inactive" : "active" });
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to update employee status."));
    }
  }

  if (employee === undefined) {
    return (
      <AppShell username={username}>
        <p className="p-6 text-sm text-ink-muted">Loading…</p>
      </AppShell>
    );
  }
  if (employee === null) {
    return (
      <AppShell username={username}>
        <p className="p-6 text-sm text-status-critical">Employee not found.</p>
      </AppShell>
    );
  }

  // checkout แบบ free-text เก่าที่น่าจะเป็นของ employee คนนี้ — คำนวณฝั่ง
  // client เพื่อโชว์เฉยๆ ตั้งใจให้ link ทีละตัวด้วยมือ ไม่ match ให้อัตโนมัติ
  // ดูเหตุผลว่าทำไมไม่สร้าง backfill อัตโนมัติได้ที่ doc comment ของ
  // migrations/0030
  const possibleMatches = allAssets.filter(
    (a) => !a.checkedOutToEmployeeId && a.checkedOutTo && a.checkedOutTo.trim().toLowerCase() === employee.name.trim().toLowerCase(),
  );

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">badge</span>
            </span>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
                {employee.name}
                {employee.status === "inactive" && (
                  <span className="rounded-full bg-gridline px-2 py-0.5 text-[11px] font-medium text-ink-muted">Inactive</span>
                )}
              </h1>
              <p className="text-xs text-ink-muted">{[employee.jobTitle, employee.departmentName].filter(Boolean).join(" · ") || "Employee"}</p>
            </div>
          </div>
          {canWrite && (
            <div className="flex gap-2">
              <Button variant="secondary" icon="edit" onClick={() => setShowEdit(true)}>
                Edit
              </Button>
              <Button variant="secondary" icon="assignment_return" onClick={() => setShowHandover(true)}>
                Hand over an asset
              </Button>
              <Button variant="secondary" icon={employee.status === "active" ? "person_off" : "person"} onClick={toggleStatus}>
                {employee.status === "active" ? "Deactivate" : "Reactivate"}
              </Button>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-status-critical">{error}</p>}

        <div className="flex gap-1 border-b border-border">
          {(["overview", "history"] as Tab[]).map((t) => (
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
          <>
            <Panel className="p-5">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Employee code</p>
                  <p className="text-ink-primary">{employee.employeeCode || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Department</p>
                  <p className="text-ink-primary">{employee.departmentName || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Job title</p>
                  <p className="text-ink-primary">{employee.jobTitle || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Status</p>
                  <p className="text-ink-primary capitalize">{employee.status}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Email</p>
                  <p className="text-ink-primary">{employee.email || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Phone</p>
                  <p className="text-ink-primary">{employee.phone || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Start date</p>
                  <p className="text-ink-primary">{employee.startDate ? employee.startDate.slice(0, 10) : "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">End date</p>
                  <p className="text-ink-primary">{employee.endDate ? employee.endDate.slice(0, 10) : "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Linked login</p>
                  <p className="text-ink-primary">{employee.username || "—"}</p>
                </div>
                {employee.notes && (
                  <div className="col-span-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Notes</p>
                    <p className="text-ink-primary">{employee.notes}</p>
                  </div>
                )}
              </div>
            </Panel>

            <Panel className="p-5">
              <h3 className="mb-3 font-semibold text-ink-primary">
                Assets currently held
                <span className="ml-1.5 font-normal text-ink-muted">({heldAssets.length})</span>
              </h3>
              {heldAssets.length === 0 ? (
                <p className="text-sm text-ink-muted">No assets currently checked out to this employee.</p>
              ) : (
                <ul className="space-y-2">
                  {heldAssets.map((a) => (
                    <li key={a.assetTag} className="rounded-md border border-border p-3 text-sm">
                      <Link href={`/assets/${encodeURIComponent(a.assetTag)}`} className="font-medium text-ink-primary hover:underline">
                        {a.assetTag}
                      </Link>
                      <p className="text-xs text-ink-muted">
                        {[a.manufacturer, a.model].filter(Boolean).join(" ") || a.category || "Asset"}
                        {a.checkoutDate ? ` · checked out ${a.checkoutDate.slice(0, 10)}` : ""}
                        {a.expectedCheckinDate ? ` · due back ${a.expectedCheckinDate.slice(0, 10)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {possibleMatches.length > 0 && (
              <Panel className="p-5">
                <h3 className="mb-1 font-semibold text-ink-primary">Possibly this employee</h3>
                <p className="mb-3 text-xs text-ink-muted">
                  These assets were checked out by name before the employee directory existed. Linking is manual and one-by-one on purpose — nothing
                  was matched automatically.
                </p>
                <ul className="space-y-2">
                  {possibleMatches.map((a) => (
                    <li key={a.assetTag} className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                      <div>
                        <Link href={`/assets/${encodeURIComponent(a.assetTag)}`} className="font-medium text-ink-primary hover:underline">
                          {a.assetTag}
                        </Link>
                        <p className="text-xs text-ink-muted">Checked out to &ldquo;{a.checkedOutTo}&rdquo;</p>
                      </div>
                      {canWrite && (
                        <Button variant="secondary" icon="link" onClick={() => handleLinkLegacyAsset(a.assetTag)}>
                          Link to this employee
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </>
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
                      <p className="text-sm text-ink-primary">
                        {ev.summary} ·{" "}
                        <Link href={`/assets/${encodeURIComponent(ev.assetTag)}`} className="text-accent hover:underline">
                          {ev.assetTag}
                        </Link>
                      </p>
                      <p className="text-xs text-ink-muted">{new Date(ev.at).toLocaleString()}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      {showEdit && (
        <EmployeeFormModal
          editing={employee}
          departments={departments}
          users={users}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            reload();
          }}
        />
      )}

      {showHandover && (
        <HandoverFormModal
          assets={allAssets}
          employees={[employee]}
          prefill={{ employeeId: employee.id }}
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

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  return <AuthGate>{(username) => <EmployeeDetail username={username} employeeId={params.id} />}</AuthGate>;
}
