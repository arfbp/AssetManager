"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createAssetAdjustment } from "@/lib/api";
import type { AdjustmentField, AssetWithLiveInfo } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const FIELD_OPTIONS: { value: AdjustmentField; label: string }[] = [
  { value: "purchase_cost", label: "Purchase cost (posts a GL entry)" },
  { value: "depreciation_years", label: "Depreciation years" },
  { value: "salvage_value", label: "Salvage value" },
  { value: "warranty_expiry_date", label: "Warranty expiry date" },
  { value: "other", label: "Other (not tracked on the asset itself)" },
];

interface AssetAdjustmentFormModalProps {
  assets: AssetWithLiveInfo[];
  onClose: () => void;
  onSaved: () => void;
}

export function AssetAdjustmentFormModal({ assets, onClose, onSaved }: AssetAdjustmentFormModalProps) {
  const [assetTag, setAssetTag] = useState("");
  const [fieldChanged, setFieldChanged] = useState<AdjustmentField>("purchase_cost");
  const [newValue, setNewValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createAssetAdjustment({ assetTag, fieldChanged, newValue, reason: reason || null });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to record adjustment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">New adjustment</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Asset
            <select autoFocus value={assetTag} onChange={(e) => setAssetTag(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              <option value="">Select an asset…</option>
              {assets.map((a) => (
                <option key={a.assetTag} value={a.assetTag}>
                  {a.assetTag}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            Field
            <select value={fieldChanged} onChange={(e) => setFieldChanged(e.target.value as AdjustmentField)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              {FIELD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            New value
            <input value={newValue} onChange={(e) => setNewValue(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <label className="block text-xs text-ink-secondary">
            Reason
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} rows={2} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy || !assetTag || !newValue.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
