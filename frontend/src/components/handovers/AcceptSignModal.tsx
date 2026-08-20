"use client";

import { useState } from "react";
import { SignaturePad } from "@/components/assets/SignaturePad";
import { ApiError, acknowledgeHandover } from "@/lib/api";
import type { Handover } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface AcceptSignModalProps {
  handover: Handover;
  eulaText: string;
  onClose: () => void;
  onSigned: () => void;
}

// แสดงแทนปุ่ม "Mark signed" แบบกดครั้งเดียวธรรมดา เมื่อ org ตั้งค่า
// checkout_eula_text ไว้ — พนักงานต้องอ่านข้อตกลงและเซ็นบนหน้าจอ แทน
// (หรือเพิ่มเติมจาก) การเซ็นด้วยปากกาบนกระดาษที่พิมพ์ออกมา
export function AcceptSignModal({ handover, eulaText, onClose, onSigned }: AcceptSignModalProps) {
  const [signature, setSignature] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await acknowledgeHandover(handover.id, { employeeSignature: signature, eulaAccepted: accepted });
      onSigned();
    } catch (err) {
      setError(errorMessage(err, "Failed to record acceptance."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Accept & sign — {handover.assetTag}</h2>
        <p className="mt-1 text-xs text-ink-muted">{handover.employeeName}</p>

        <div className="mt-4 max-h-40 overflow-y-auto rounded-md border border-border bg-page p-3 text-xs text-ink-secondary whitespace-pre-line">
          {eulaText}
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs text-ink-secondary">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="h-4 w-4 rounded border-border" />
          I have read and accept these terms
        </label>

        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-ink-secondary">Signature</p>
          <SignaturePad onChange={setSignature} />
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !accepted || !signature}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Accept & sign"}
          </button>
        </div>
      </div>
    </div>
  );
}
