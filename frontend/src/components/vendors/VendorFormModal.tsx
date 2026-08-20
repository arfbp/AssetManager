"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createVendor, updateVendor } from "@/lib/api";
import type { Vendor } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export interface VendorPrefill {
  name?: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

interface VendorFormModalProps {
  editing?: Vendor | null;
  // ค่าที่ดึงมาแบบเดาที่ดีที่สุดจาก AI console (ดูผลตัดสิน "admin_form"
  // ใน server/src/security/erpGuardrail.ts) — ผู้ใช้ยังต้องตรวจสอบและ
  // แก้ไขได้ทุก field ก่อนกดส่ง
  prefill?: VendorPrefill;
  onClose: () => void;
  onSaved: (vendor: Vendor) => void;
}

export function VendorFormModal({ editing, prefill, onClose, onSaved }: VendorFormModalProps) {
  const [name, setName] = useState(editing?.name ?? prefill?.name ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [legalName, setLegalName] = useState(editing?.legalName ?? "");
  const [taxId, setTaxId] = useState(editing?.taxId ?? "");
  const [contactName, setContactName] = useState(editing?.contactName ?? prefill?.contactName ?? "");
  const [email, setEmail] = useState(editing?.email ?? prefill?.email ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? prefill?.phone ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [paymentTerms, setPaymentTerms] = useState(editing?.paymentTerms ?? "");
  const [bankAccountInfo, setBankAccountInfo] = useState(editing?.bankAccountInfo ?? "");
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
      legalName: legalName || null,
      taxId: taxId || null,
      contactName: contactName || null,
      email: email || null,
      phone: phone || null,
      address: address || null,
      paymentTerms: paymentTerms || null,
      bankAccountInfo: bankAccountInfo || null,
      notes: notes || null,
    };
    try {
      const res = editing ? await updateVendor(editing.id, payload) : await createVendor(payload);
      onSaved(res.vendor);
    } catch (err) {
      setError(errorMessage(err, "Failed to save vendor."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">{editing ? `Edit ${editing.name}` : "New vendor"}</h2>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Category
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={busy}
              placeholder="e.g. Equipment supplier, Maintenance/MA provider"
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Legal (registered) name
              <input
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Tax ID
              <input
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Contact name
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Phone
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-ink-secondary">
              Payment terms
              <input
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                disabled={busy}
                placeholder="e.g. Credit 30 days"
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Bank account
              <input
                value={bankAccountInfo}
                onChange={(e) => setBankAccountInfo(e.target.value)}
                disabled={busy}
                placeholder="Bank, account no., account name"
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
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
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
