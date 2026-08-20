"use client";

import { useState, type FormEvent } from "react";
import { ApiError, retireAsset } from "@/lib/api";
import type { RetirementReason } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const REASON_OPTIONS: { value: RetirementReason; label: string }[] = [
  { value: "disposed", label: "Disposed" },
  { value: "sold", label: "Sold" },
  { value: "lost", label: "Lost" },
  { value: "stolen", label: "Stolen" },
  { value: "donated", label: "Donated" },
  { value: "other", label: "Other" },
];

interface RetireAssetModalProps {
  assetTag: string;
  onClose: () => void;
  onRetired: () => void;
}

export function RetireAssetModal({ assetTag, onClose, onRetired }: RetireAssetModalProps) {
  const [reason, setReason] = useState<RetirementReason>("disposed");
  const [disposalMethod, setDisposalMethod] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await retireAsset({ assetTag, reason, disposalMethod: disposalMethod || null, proceeds: proceeds === "" ? null : Number(proceeds), notes: notes || null });
      onRetired();
    } catch (err) {
      setError(errorMessage(err, "Failed to retire asset."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-status-critical/30 bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-status-critical">Retire {assetTag}</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          This permanently marks the asset retired and, if it has a purchase cost on file, posts a disposal entry removing it from the ledger.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value as RetirementReason)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              {REASON_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            Disposal method
            <input value={disposalMethod} onChange={(e) => setDisposalMethod(e.target.value)} disabled={busy} placeholder="e.g. Recycled via e-waste vendor" className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          {reason === "sold" && (
            <label className="block text-xs text-ink-secondary">
              Proceeds
              <input type="number" min={0} step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
          )}
          <label className="block text-xs text-ink-secondary">
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} rows={2} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-md bg-status-critical px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            {busy ? "Retiring…" : "Retire asset"}
          </button>
        </div>
      </form>
    </div>
  );
}
