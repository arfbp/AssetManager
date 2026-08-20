"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmployeeFormModal } from "@/components/employees/EmployeeFormModal";
import { DepartmentsModal } from "@/components/employees/DepartmentsModal";
import { ImportEmployeesModal } from "@/components/employees/ImportEmployeesModal";
import { ApiError, getEmployees, getDepartments, getUsers, deleteEmployee, updateEmployee } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { Employee, Department, UserSummary } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

type StatusFilter = "active" | "inactive" | "all";

function Employees({ username }: { username: string }) {
  const canWrite = getStoredRole() !== "viewer";
  const isAdmin = getStoredRole() === "admin";
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [showDepartments, setShowDepartments] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getEmployees()
      .then((res) => setEmployees(res.employees))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load employees.")));
  }

  function reloadDepartments(): void {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => setDepartments([]));
  }

  useEffect(() => {
    reload();
    reloadDepartments();
    // GET /users จำกัดให้ admin เท่านั้น — ถ้าไม่ใช่ admin แล้วโดน 403
    // ก็แค่ซ่อน field linked-login ในฟอร์มไป ไม่ต้องโชว์ error ตรงนี้
    if (isAdmin) {
      getUsers()
        .then((res) => setUsers(res.users))
        .catch(() => setUsers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteEmployee(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete employee."));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(e: Employee): Promise<void> {
    setActionError(null);
    try {
      await updateEmployee(e.id, { status: e.status === "active" ? "inactive" : "active" });
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to update employee status."));
    }
  }

  const filtered = (employees ?? []).filter((e) => {
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (departmentFilter && e.departmentId !== departmentFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      (e.employeeCode ?? "").toLowerCase().includes(q) ||
      (e.email ?? "").toLowerCase().includes(q) ||
      (e.departmentName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">badge</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Employees</h1>
              <p className="text-xs text-ink-muted">People assets are issued to.</p>
            </div>
          </div>
          {canWrite && (
            <div className="flex gap-2">
              <Button variant="secondary" icon="apartment" onClick={() => setShowDepartments(true)}>
                Manage departments
              </Button>
              <Button variant="secondary" icon="upload_file" onClick={() => setShowImport(true)}>
                Import
              </Button>
              <Button variant="primary" icon="add" onClick={() => setEditing("new")}>
                New employee
              </Button>
            </div>
          )}
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, email, department…"
            className="w-full max-w-sm rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
          {departments.length > 0 && (
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <Panel>
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : employees === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">No employees match.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Code", "Department", "Job title", "Email", "Status", "Assets", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td className="p-4 text-sm font-medium text-ink-primary">
                      <Link href={`/employees/${e.id}`} className="hover:underline">
                        {e.name}
                      </Link>
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{e.employeeCode || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{e.departmentName || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{e.jobTitle || "—"}</td>
                    <td className="p-4 text-sm text-ink-secondary">{e.email || "—"}</td>
                    <td className="p-4 text-sm">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          e.status === "active" ? "bg-status-good/10 text-status-good" : "bg-gridline text-ink-muted"
                        }`}
                      >
                        {e.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="p-4 text-sm text-ink-secondary">{e.assetCount}</td>
                    <td className="p-4 text-right">
                      {canWrite && (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" icon="edit" onClick={() => setEditing(e)}>
                            Edit
                          </Button>
                          <Button variant="secondary" icon={e.status === "active" ? "person_off" : "person"} onClick={() => toggleStatus(e)}>
                            {e.status === "active" ? "Deactivate" : "Reactivate"}
                          </Button>
                          <Button variant="danger" icon="delete" onClick={() => setDeleteTarget(e)}>
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
        <EmployeeFormModal
          editing={editing === "new" ? null : editing}
          departments={departments}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      {showDepartments && <DepartmentsModal onClose={() => setShowDepartments(false)} onChanged={reloadDepartments} />}

      {showImport && (
        <ImportEmployeesModal
          onClose={() => setShowImport(false)}
          onImported={() => {
            reload();
            reloadDepartments();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.name}"?`}
        message="This can't be undone. Employees with assets, handovers or requests on file can't be deleted — deactivate them instead to keep their history."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function EmployeesPage() {
  return <AuthGate>{(username) => <Employees username={username} />}</AuthGate>;
}
