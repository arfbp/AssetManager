"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createAssetTransfer } from "@/lib/api";
import type { AssetWithLiveInfo } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface AssetTransferFormModalProps {
  assets: AssetWithLiveInfo[];
  onClose: () => void;
  onSaved: () => void;
}

export function AssetTransferFormModal({ assets, onClose, onSaved }: AssetTransferFormModalProps) {
  const [assetTag, setAssetTag] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [fromDepartment, setFromDepartment] = useState("");
  const [toDepartment, setToDepartment] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentAsset = assets.find((a) => a.assetTag === assetTag);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createAssetTransfer({ assetTag, toLocation: toLocation || null, fromDepartment: fromDepartment || null, toDepartment: toDepartment || null, reason: reason || null });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to create transfer."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">New transfer</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Asset
            <select autoFocus value={assetTag} onChange={(e) => setAssetTag(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              <option value="">Select an asset…</option>
              {assets.map((a) => (
                <option key={a.assetTag} value={a.assetTag}>
                  {a.assetTag} {a.location ? `(currently: ${a.location})` : ""}
                </option>
              ))}
            </select>
          </label>
          {currentAsset && <p className="text-xs text-ink-muted">Current location: {currentAsset.location || "—"}</p>}
          <label className="block text-xs text-ink-secondary">
            New location
            <input value={toLocation} onChange={(e) => setToLocation(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              From department
              <input value={fromDepartment} onChange={(e) => setFromDepartment(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-secondary">
              To department
              <input value={toDepartment} onChange={(e) => setToDepartment(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy || !assetTag} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
