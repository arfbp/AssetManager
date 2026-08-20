"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, createLicense, updateLicense, getVendors } from "@/lib/api";
import type { SoftwareLicense, Vendor } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface LicenseFormModalProps {
  editing?: SoftwareLicense | null;
  onClose: () => void;
  onSaved: () => void;
}

export function LicenseFormModal({ editing, onClose, onSaved }: LicenseFormModalProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [name, setName] = useState(editing?.name ?? "");
  const [vendorId, setVendorId] = useState(editing?.vendorId ?? "");
  const [licenseKey, setLicenseKey] = useState(editing?.licenseKey ?? "");
  const [seats, setSeats] = useState(editing?.seats !== null && editing?.seats !== undefined ? String(editing.seats) : "");
  const [purchaseDate, setPurchaseDate] = useState(editing?.purchaseDate?.slice(0, 10) ?? "");
  const [expiryDate, setExpiryDate] = useState(editing?.expiryDate?.slice(0, 10) ?? "");
  const [cost, setCost] = useState(editing?.cost !== null && editing?.cost !== undefined ? String(editing.cost) : "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVendors()
      .then((res) => setVendors(res.vendors))
      .catch(() => setVendors([]));
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      vendorId: vendorId || null,
      licenseKey: licenseKey || null,
      seats: seats === "" ? null : Number(seats),
      purchaseDate: purchaseDate || null,
      expiryDate: expiryDate || null,
      cost: cost === "" ? null : Number(cost),
      notes: notes || null,
    };
    try {
      if (editing) await updateLicense(editing.id, payload);
      else await createLicense(payload);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save license."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? `Edit ${editing.name}` : "New software license"}</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="e.g. Microsoft 365 E3" className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <label className="block text-xs text-ink-secondary">
            Vendor
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              <option value="">None</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            License key
            <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Seats
              <input type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-secondary">
              Cost
              <input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Purchase date
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-secondary">
              Expiry date
              <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} disabled={busy} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
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
