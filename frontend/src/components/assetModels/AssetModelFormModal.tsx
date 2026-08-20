"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createAssetModel, updateAssetModel } from "@/lib/api";
import type { AssetModel } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface AssetModelFormModalProps {
  editing?: AssetModel | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AssetModelFormModal({ editing, onClose, onSaved }: AssetModelFormModalProps) {
  const [name, setName] = useState(editing?.name ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [manufacturer, setManufacturer] = useState(editing?.manufacturer ?? "");
  const [model, setModel] = useState(editing?.model ?? "");
  const [depreciationYears, setDepreciationYears] = useState(editing?.depreciationYears !== null && editing?.depreciationYears !== undefined ? String(editing.depreciationYears) : "");
  const [salvageValue, setSalvageValue] = useState(editing?.salvageValue !== null && editing?.salvageValue !== undefined ? String(editing.salvageValue) : "");
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
      category: category || null,
      manufacturer: manufacturer || null,
      model: model || null,
      depreciationYears: depreciationYears === "" ? null : Number(depreciationYears),
      salvageValue: salvageValue === "" ? null : Number(salvageValue),
      notes: notes || null,
    };
    try {
      if (editing) await updateAssetModel(editing.id, payload);
      else await createAssetModel(payload);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save asset model."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? `Edit ${editing.name}` : "New asset model"}</h2>
        <p className="mt-1 text-xs text-ink-muted">A reusable template — its fields only prefill the "New asset" form once, not kept in sync afterward.</p>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Dell Latitude 5440"
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Category
              <input value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-secondary">
              Manufacturer
              <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Depreciation (years)
              <input type="number" min={1} value={depreciationYears} onChange={(e) => setDepreciationYears(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-secondary">
              Salvage value
              <input type="number" min={0} step="0.01" value={salvageValue} onChange={(e) => setSalvageValue(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
          </div>
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
          <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
