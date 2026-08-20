"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createHandover } from "@/lib/api";
import type { AssetWithLiveInfo, Employee, Handover } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const MANUAL_EMPLOYEE = "__manual__";

export interface HandoverPrefill {
  assetTag?: string;
  employeeId?: string;
  employeeName?: string;
  employeeEmail?: string;
  employeeDepartment?: string;
}

interface HandoverFormModalProps {
  assets: AssetWithLiveInfo[];
  employees?: Employee[];
  prefill?: HandoverPrefill;
  onClose: () => void;
  onCreated: (handover: Handover) => void;
}

export function HandoverFormModal({ assets, employees = [], prefill, onClose, onCreated }: HandoverFormModalProps) {
  const [assetTag, setAssetTag] = useState(prefill?.assetTag ?? "");
  // ควบคุมแบบ 3 สถานะ เหมือน checkout select ของ AssetFormModal: เป็น
  // employee id จริง, MANUAL_EMPLOYEE สำหรับ "คนที่ไม่มีในระบบ" หรือ ""
  // (ยังไม่ได้เลือก) เริ่มที่ MANUAL_EMPLOYEE เมื่อ prefill มีชื่อแบบ
  // free-text มาแล้วแต่ไม่มี id หรือตอนที่ directory ว่างเปล่า เพื่อให้ช่อง
  // free-text ใช้งานได้ทันที
  const [employeeId, setEmployeeId] = useState(prefill?.employeeId ?? (prefill?.employeeName || employees.length === 0 ? MANUAL_EMPLOYEE : ""));
  const [employeeName, setEmployeeName] = useState(prefill?.employeeName ?? "");
  const [employeeEmail, setEmployeeEmail] = useState(prefill?.employeeEmail ?? "");
  const [employeeDepartment, setEmployeeDepartment] = useState(prefill?.employeeDepartment ?? "");
  const [handoverDate, setHandoverDate] = useState(new Date().toISOString().slice(0, 10));
  const [conditionNotes, setConditionNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleEmployeeSelect(value: string): void {
    setEmployeeId(value);
    if (value === MANUAL_EMPLOYEE || value === "") return;
    const found = employees.find((e) => e.id === value);
    if (!found) return;
    // กรอกให้ครั้งเดียว เหมือน select ของ model/employee ใน
    // AssetFormModal — หลังจากนั้นแก้ไขได้อิสระ ไม่ sync กับข้อมูลใน
    // directory อีก
    setEmployeeName(found.name);
    setEmployeeEmail(found.email ?? "");
    setEmployeeDepartment(found.departmentName ?? "");
  }

  const isManual = employeeId === MANUAL_EMPLOYEE || employees.length === 0;
  const canSubmit = Boolean(assetTag) && (isManual ? Boolean(employeeName.trim()) : Boolean(employeeId));

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createHandover({
        assetTag,
        employeeId: isManual ? null : employeeId,
        employeeName: isManual ? employeeName.trim() : undefined,
        employeeEmail: employeeEmail || null,
        employeeDepartment: employeeDepartment || null,
        handoverDate,
        conditionNotes: conditionNotes || null,
      });
      onCreated(res.handover);
    } catch (err) {
      setError(errorMessage(err, "Failed to create handover."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Hand over an asset</h2>
        <p className="mt-1 text-xs text-ink-muted">Creates a custody record and a printable form the employee can sign.</p>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Asset
            <select
              autoFocus
              value={assetTag}
              onChange={(e) => setAssetTag(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              <option value="">Select an asset…</option>
              {assets.map((a) => (
                <option key={a.assetTag} value={a.assetTag}>
                  {a.assetTag} {a.model ? `— ${a.model}` : ""}
                </option>
              ))}
            </select>
          </label>

          {employees.length > 0 && (
            <label className="block text-xs text-ink-secondary">
              Employee
              <select
                value={employeeId}
                onChange={(e) => handleEmployeeSelect(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              >
                <option value="">Select an employee…</option>
                {employees
                  .filter((e) => e.status === "active" || e.id === employeeId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.departmentName ? ` — ${e.departmentName}` : ""}
                    </option>
                  ))}
                <option value={MANUAL_EMPLOYEE}>Someone not in the directory…</option>
              </select>
            </label>
          )}

          {isManual && (
            <label className="block text-xs text-ink-secondary">
              Employee name
              <input
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Email
              <input
                type="email"
                value={employeeEmail}
                onChange={(e) => setEmployeeEmail(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Department
              <input
                value={employeeDepartment}
                onChange={(e) => setEmployeeDepartment(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Handover date
            <input
              type="date"
              value={handoverDate}
              onChange={(e) => setHandoverDate(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Condition notes
            <textarea
              value={conditionNotes}
              onChange={(e) => setConditionNotes(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="Any existing scratches, missing accessories, etc."
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
            disabled={busy || !canSubmit}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create & print"}
          </button>
        </div>
      </form>
    </div>
  );
}
