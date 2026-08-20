"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, createPurchaseOrder, getVendors } from "@/lib/api";
import type { NewPurchaseOrderItemInput, Vendor } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export interface PurchaseOrderPrefill {
  vendorId?: string;
  vendorName?: string;
  itemDescription?: string;
  quantity?: string;
  unitCost?: string;
}

interface LineItemDraft {
  description: string;
  quantity: string;
  unitCost: string;
  assetCategory: string;
}

function emptyLine(): LineItemDraft {
  return { description: "", quantity: "1", unitCost: "", assetCategory: "" };
}

interface PurchaseOrderFormModalProps {
  // ค่าที่ดึงมาแบบเดาที่ดีที่สุดจาก AI console (ดูผลตัดสิน "admin_form"
  // ใน server/src/security/erpGuardrail.ts) — ผู้ใช้ยังต้องตรวจสอบและ
  // แก้ไขได้ทุก field รวมถึงเพิ่มรายการสินค้าเองก่อนกดส่ง
  prefill?: PurchaseOrderPrefill;
  onClose: () => void;
  onCreated: () => void;
}

export function PurchaseOrderFormModal({ prefill, onClose, onCreated }: PurchaseOrderFormModalProps) {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [vendorId, setVendorId] = useState(prefill?.vendorId ?? "");
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItemDraft[]>(() => [
    prefill?.itemDescription
      ? { description: prefill.itemDescription, quantity: prefill.quantity || "1", unitCost: prefill.unitCost || "", assetCategory: "" }
      : emptyLine(),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVendors()
      .then((res) => setVendors(res.vendors))
      .catch(() => setVendors([]));
  }, []);

  function updateItem(index: number, patch: Partial<LineItemDraft>): void {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function removeItem(index: number): void {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const total = items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitCost) || 0), 0);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const cleanItems: NewPurchaseOrderItemInput[] = items
        .filter((it) => it.description.trim())
        .map((it) => ({
          description: it.description.trim(),
          quantity: Math.max(1, Number(it.quantity) || 1),
          unitCost: Math.max(0, Number(it.unitCost) || 0),
          assetCategory: it.assetCategory || null,
        }));
      if (cleanItems.length === 0) {
        setError("Add at least one line item.");
        setBusy(false);
        return;
      }
      await createPurchaseOrder({
        vendorId,
        orderDate: orderDate || null,
        expectedDeliveryDate: expectedDeliveryDate || null,
        notes: notes || null,
        items: cleanItems,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Failed to create purchase order."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">New purchase order</h2>
        {prefill?.vendorName && !vendorId && (
          <p className="mt-1 text-xs text-status-warning">
            AI extracted vendor "{prefill.vendorName}" but couldn't match it to an existing vendor — pick one below, or create it first from the Vendors page.
          </p>
        )}

        <div className="mt-4 grid grid-cols-3 gap-3">
          <label className="col-span-3 text-xs text-ink-secondary">
            Vendor
            <select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              <option value="">Select a vendor…</option>
              {(vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-secondary">
            Order date
            <input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="col-span-2 text-xs text-ink-secondary">
            Expected delivery
            <input
              type="date"
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Line items</p>
            <button type="button" onClick={() => setItems((prev) => [...prev, emptyLine()])} className="text-xs font-medium text-accent hover:underline">
              + Add item
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {items.map((item, i) => (
              <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-md border border-border p-2">
                <label className="col-span-5 text-[11px] text-ink-secondary">
                  Description
                  <input
                    value={item.description}
                    onChange={(e) => updateItem(i, { description: e.target.value })}
                    disabled={busy}
                    className="mt-1 w-full rounded-md border border-border bg-page px-2 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                  />
                </label>
                <label className="col-span-2 text-[11px] text-ink-secondary">
                  Qty
                  <input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) => updateItem(i, { quantity: e.target.value })}
                    disabled={busy}
                    className="mt-1 w-full rounded-md border border-border bg-page px-2 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                  />
                </label>
                <label className="col-span-2 text-[11px] text-ink-secondary">
                  Unit cost
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitCost}
                    onChange={(e) => updateItem(i, { unitCost: e.target.value })}
                    disabled={busy}
                    className="mt-1 w-full rounded-md border border-border bg-page px-2 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                  />
                </label>
                <label className="col-span-2 text-[11px] text-ink-secondary">
                  Category
                  <input
                    value={item.assetCategory}
                    onChange={(e) => updateItem(i, { assetCategory: e.target.value })}
                    disabled={busy}
                    placeholder="Laptop"
                    className="mt-1 w-full rounded-md border border-border bg-page px-2 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                  />
                </label>
                <div className="col-span-1 flex justify-end">
                  {items.length > 1 && (
                    <button type="button" onClick={() => removeItem(i)} disabled={busy} className="text-ink-muted hover:text-status-critical disabled:opacity-50">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-right text-sm font-semibold text-ink-primary">Total: ${total.toFixed(2)}</p>
        </div>

        <label className="mt-3 block text-xs text-ink-secondary">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
            rows={2}
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !vendorId}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Creating…" : "Submit for approval"}
          </button>
        </div>
      </form>
    </div>
  );
}
