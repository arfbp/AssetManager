"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createMaintenanceRecord, updateMaintenanceRecord } from "@/lib/api";
import type { AssetWithLiveInfo, MaintenanceRecord, MaintenanceType } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const TYPE_OPTIONS: { value: MaintenanceType; label: string }[] = [
  { value: "scheduled", label: "Scheduled maintenance" },
  { value: "repair", label: "Repair" },
  { value: "inspection", label: "Inspection" },
];

export interface MaintenancePrefill {
  assetTag?: string;
  description?: string;
  scheduledDate?: string;
}

interface MaintenanceFormModalProps {
  editing?: MaintenanceRecord | null;
  assets: AssetWithLiveInfo[];
  prefill?: MaintenancePrefill;
  onClose: () => void;
  onSaved: () => void;
}

export function MaintenanceFormModal({ editing, assets, prefill, onClose, onSaved }: MaintenanceFormModalProps) {
  const [assetTag, setAssetTag] = useState(editing?.assetTag ?? prefill?.assetTag ?? "");
  const [type, setType] = useState<MaintenanceType>(editing?.type ?? "scheduled");
  const [description, setDescription] = useState(editing?.description ?? prefill?.description ?? "");
  const [scheduledDate, setScheduledDate] = useState(editing?.scheduledDate?.slice(0, 10) ?? prefill?.scheduledDate ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updateMaintenanceRecord(editing.id, { type, description, scheduledDate: scheduledDate || null, notes: notes || null });
      } else {
        await createMaintenanceRecord({ assetTag, type, description, scheduledDate: scheduledDate || null, notes: notes || null });
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save maintenance record."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? "Edit maintenance record" : "Schedule maintenance"}</h2>

        <div className="mt-4 space-y-3">
          {!editing && (
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
                    {a.assetTag}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs text-ink-secondary">
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as MaintenanceType)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              placeholder="e.g. Replace battery, annual inspection"
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Scheduled date
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
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
            disabled={busy || !assetTag || !description.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
