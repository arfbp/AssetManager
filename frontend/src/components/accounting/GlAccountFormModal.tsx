"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createGlAccount, updateGlAccount } from "@/lib/api";
import type { GlAccount, GlAccountType } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const TYPE_OPTIONS: { value: GlAccountType; label: string }[] = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "expense", label: "Expense" },
];

interface GlAccountFormModalProps {
  editing?: GlAccount | null;
  onClose: () => void;
  onSaved: () => void;
}

export function GlAccountFormModal({ editing, onClose, onSaved }: GlAccountFormModalProps) {
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [type, setType] = useState<GlAccountType>(editing?.type ?? "asset");
  const [isContra, setIsContra] = useState(editing?.isContra ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateGlAccount(editing.id, { code, name, type, isContra });
      else await createGlAccount({ code, name, type, isContra });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save account."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? `Edit ${editing.code}` : "New account"}</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Code
            <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} placeholder="e.g. 1500" className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <label className="block text-xs text-ink-secondary">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <label className="block text-xs text-ink-secondary">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as GlAccountType)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input type="checkbox" checked={isContra} onChange={(e) => setIsContra(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Contra account (reduces its own type's normal balance, e.g. Accumulated Depreciation)
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy || !code.trim() || !name.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
