"use client";

import { useState } from "react";
import { ApiError, approveAssetRequest } from "@/lib/api";
import type { AssetRequest, Employee } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// เดาแบบดีที่สุด: เช็คพนักงานที่ผูกกับล็อกอินนี้ก่อน แล้วค่อย fallback ไป
// จับคู่ชื่อ/อีเมลแบบ case-insensitive กับ username ของผู้ขอ — ทั้งสองทาง
// อาจผิดหรือไม่มีข้อมูลก็ได้ จึงให้เป็นแค่ค่าเสนอแนะที่ผู้อนุมัติต้อง
// ยืนยันเอง ไม่ใช่ค่าที่ระบบเลือกให้อัตโนมัติ
function guessEmployee(employees: Employee[], requestedBy: string): Employee | null {
  const byUsername = employees.find((e) => e.username === requestedBy);
  if (byUsername) return byUsername;
  const q = requestedBy.toLowerCase();
  return employees.find((e) => e.name.toLowerCase() === q || e.email?.toLowerCase() === q) ?? null;
}

interface ApproveRequestModalProps {
  request: AssetRequest;
  employees: Employee[];
  onClose: () => void;
  onApproved: () => void;
}

export function ApproveRequestModal({ request, employees, onClose, onApproved }: ApproveRequestModalProps) {
  const [employeeId, setEmployeeId] = useState(guessEmployee(employees, request.requestedBy)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveAssetRequest(request.id, employeeId || null);
      onApproved();
    } catch (err) {
      setError(errorMessage(err, "Failed to approve request."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Approve request for {request.assetTag}</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          <span className="font-medium text-ink-primary">{request.requestedBy}</span> requested this. Who is actually receiving the asset?
        </p>

        <div className="mt-4">
          <label className="block text-xs text-ink-secondary">
            Employee
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              <option value="">— not in the directory —</option>
              {employees
                .filter((e) => e.status === "active" || e.id === employeeId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.departmentName ? ` — ${e.departmentName}` : ""}
                  </option>
                ))}
            </select>
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApprove}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Approving…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
