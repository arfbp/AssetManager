"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, getDepartments, createDepartment, updateDepartment, deleteDepartment } from "@/lib/api";
import type { Department } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface DepartmentsModalProps {
  onClose: () => void;
  // เรียกทุกครั้งที่รายการเปลี่ยนแปลงจริง (เพิ่ม/เปลี่ยนชื่อ/ลบ) เพื่อให้
  // หน้า Employees ที่เป็น parent ดึงข้อมูลใหม่และอัปเดต dropdown/filter
  // แผนกของตัวเองให้ตรงกัน
  onChanged: () => void;
}

export function DepartmentsModal({ onClose, onChanged }: DepartmentsModalProps) {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newName, setNewName] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  function reload(): void {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch((err) => setError(errorMessage(err, "Couldn't load departments.")));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleAdd(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (addBusy || !newName.trim()) return;
    setAddBusy(true);
    setError(null);
    try {
      await createDepartment({ name: newName.trim() });
      setNewName("");
      reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to add department."));
    } finally {
      setAddBusy(false);
    }
  }

  function startRename(d: Department): void {
    setRenamingId(d.id);
    setRenameValue(d.name);
  }

  async function commitRename(id: string): Promise<void> {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await updateDepartment(id, { name: renameValue.trim() });
      setRenamingId(null);
      reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to rename department."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await deleteDepartment(id);
      reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to delete department."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Manage departments</h2>

        {error && <p className="mt-2 text-xs text-status-critical">{error}</p>}

        <div className="mt-4 max-h-[50vh] space-y-1.5 overflow-y-auto">
          {departments === null ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : departments.length === 0 ? (
            <p className="text-sm text-ink-muted">No departments yet.</p>
          ) : (
            departments.map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                {renamingId === d.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(d.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    disabled={busyId === d.id}
                    className="flex-1 rounded-md border border-border bg-page px-2 py-1 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                  />
                ) : (
                  <button type="button" onClick={() => startRename(d)} className="flex-1 truncate text-left text-sm text-ink-primary hover:underline">
                    {d.name}
                  </button>
                )}
                <span className="text-xs text-ink-muted">({d.employeeCount})</span>
                <button
                  type="button"
                  onClick={() => handleDelete(d.id)}
                  disabled={busyId === d.id}
                  className="material-symbols-outlined text-[16px] text-ink-muted hover:text-status-critical disabled:opacity-50"
                  aria-label={`Delete ${d.name}`}
                >
                  delete
                </button>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleAdd} className="mt-4 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New department name…"
            disabled={addBusy}
            className="flex-1 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={addBusy || !newName.trim()}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Add
          </button>
        </form>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
