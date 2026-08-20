"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createAssetRequest } from "@/lib/api";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface AssetRequestModalProps {
  assetTag: string;
  onClose: () => void;
  onRequested: () => void;
}

export function AssetRequestModal({ assetTag, onClose, onRequested }: AssetRequestModalProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createAssetRequest(assetTag, note || null);
      onRequested();
    } catch (err) {
      setError(errorMessage(err, "Failed to submit request."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Request {assetTag}</h2>
        <p className="mt-1 text-xs text-ink-muted">An admin will review and approve or reject this request.</p>
        <label className="mt-4 block text-xs text-ink-secondary">
          Note (optional)
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={3}
            placeholder="Why do you need this asset?"
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>
        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
    </div>
  );
}
