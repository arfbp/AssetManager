"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createEmployee, updateEmployee } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import type { Department, Employee, EmployeeStatus, UserSummary } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface EmployeeFormModalProps {
  editing?: Employee | null;
  departments: Department[];
  // ฝั่งที่เรียกใช้จะดึง/ส่งค่านี้มาให้ก็ต่อเมื่อเป็น session ของ admin
  // เท่านั้น — เพราะ GET /users เป็น endpoint สำหรับ admin เท่านั้นอยู่แล้ว
  // ผู้ใช้ role it_support จึงไม่เห็น field นี้เลย ไม่ใช่แค่เห็นแบบ disabled
  users?: UserSummary[];
  onClose: () => void;
  onSaved: (employee: Employee) => void;
}

export function EmployeeFormModal({ editing, departments, users = [], onClose, onSaved }: EmployeeFormModalProps) {
  const isAdmin = getStoredRole() === "admin";
  const [name, setName] = useState(editing?.name ?? "");
  const [employeeCode, setEmployeeCode] = useState(editing?.employeeCode ?? "");
  const [jobTitle, setJobTitle] = useState(editing?.jobTitle ?? "");
  const [departmentId, setDepartmentId] = useState(editing?.departmentId ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [status, setStatus] = useState<EmployeeStatus>(editing?.status ?? "active");
  const [startDate, setStartDate] = useState(editing?.startDate?.slice(0, 10) ?? "");
  const [endDate, setEndDate] = useState(editing?.endDate?.slice(0, 10) ?? "");
  const [userId, setUserId] = useState(editing?.userId ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      employeeCode: employeeCode || null,
      jobTitle: jobTitle || null,
      departmentId: departmentId || null,
      email: email || null,
      phone: phone || null,
      status,
      startDate: startDate || null,
      endDate: endDate || null,
      userId: isAdmin ? userId || null : undefined,
      notes: notes || null,
    };
    try {
      const res = editing ? await updateEmployee(editing.id, payload) : await createEmployee(payload);
      onSaved(res.employee);
    } catch (err) {
      setError(errorMessage(err, "Failed to save employee."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? `Edit ${editing.name}` : "New employee"}</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Employee code
              <input
                value={employeeCode}
                onChange={(e) => setEmployeeCode(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Job title
              <input
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>

          <label className="block text-xs text-ink-secondary">
            Department
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              <option value="">None</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Phone
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>

          <label className="block text-xs text-ink-secondary">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as EmployeeStatus)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              End date
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>

          {isAdmin && users.length > 0 && (
            <label className="block text-xs text-ink-secondary">
              Linked login
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              >
                <option value="">None</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-ink-muted">Optional — lets self-service requests from this login be matched to this employee.</span>
            </label>
          )}

          <label className="block text-xs text-ink-secondary">
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
