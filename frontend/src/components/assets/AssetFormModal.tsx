"use client";

import { useState, type FormEvent } from "react";
import { createAsset, updateAsset, ApiError } from "@/lib/api";
import type { AssetInput, AssetStatus, AssetType, AssetWithLiveInfo } from "@/lib/types";

const STATUS_OPTIONS: { value: AssetStatus; label: string }[] = [
  { value: "ready_to_deploy", label: "Ready to deploy" },
  { value: "deployed", label: "Deployed" },
  { value: "in_repair", label: "In repair" },
  { value: "retired", label: "Retired" },
];

interface AssetFormModalProps {
  // Present when editing an existing asset; absent when creating a new one.
  editing: AssetWithLiveInfo | null;
  // Starting values for a new asset — used by the "register this connected
  // device as an asset" flow (ProcessManagerDrawer's peripheral list) to
  // pre-fill manufacturer/model/serial instead of making the operator type
  // them in by hand. Ignored when `editing` is set.
  prefill?: AssetInput;
  // Hostnames of connected devices with no asset record yet — offered as
  // quick-pick options for "link to device" rather than requiring the
  // operator to type a hostname from memory.
  unregisteredAgents: string[];
  onClose: () => void;
  onSaved: () => void;
}

export function AssetFormModal({ editing, prefill, unregisteredAgents, onClose, onSaved }: AssetFormModalProps) {
  const base = editing ?? prefill;
  const [assetTag, setAssetTag] = useState(editing?.assetTag ?? "");
  const [assetType, setAssetType] = useState<AssetType>(base?.assetType ?? "computer");
  const [agentId, setAgentId] = useState(editing?.agentId ?? "");
  const [status, setStatus] = useState<AssetStatus>(base?.status ?? "ready_to_deploy");
  const [category, setCategory] = useState(base?.category ?? "");
  const [location, setLocation] = useState(base?.location ?? "");
  const [orderNumber, setOrderNumber] = useState(base?.orderNumber ?? "");
  const [checkedOutTo, setCheckedOutTo] = useState(base?.checkedOutTo ?? "");
  const [checkoutDate, setCheckoutDate] = useState(base?.checkoutDate?.slice(0, 10) ?? "");
  const [expectedCheckinDate, setExpectedCheckinDate] = useState(base?.expectedCheckinDate?.slice(0, 10) ?? "");
  const [eolDate, setEolDate] = useState(base?.eolDate?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(base?.notes ?? "");
  const [manualSerialNumber, setManualSerialNumber] = useState(base?.manualSerialNumber ?? "");
  const [manufacturer, setManufacturer] = useState(base?.manufacturer ?? "");
  const [model, setModel] = useState(base?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPeripheral = assetType === "peripheral";
  const parentAgentId = editing?.parentAgentId ?? prefill?.parentAgentId ?? null;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const payload = {
      agentId: isPeripheral ? null : agentId || null,
      status,
      category: category || null,
      location: location || null,
      orderNumber: orderNumber || null,
      checkedOutTo: checkedOutTo || null,
      checkoutDate: checkoutDate || null,
      expectedCheckinDate: expectedCheckinDate || null,
      eolDate: eolDate || null,
      notes: notes || null,
      manualSerialNumber: manualSerialNumber || null,
      assetType,
      manufacturer: isPeripheral ? manufacturer || null : null,
      model: isPeripheral ? model || null : null,
      parentAgentId: isPeripheral ? parentAgentId : null,
    };

    try {
      if (editing) {
        await updateAsset(editing.assetTag, payload);
      } else {
        await createAsset({ ...payload, assetTag: assetTag || undefined });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save asset.");
    } finally {
      setBusy(false);
    }
  }

  const linkableAgents = editing?.agentId
    ? [editing.agentId, ...unregisteredAgents.filter((a) => a !== editing.agentId)]
    : unregisteredAgents;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-ink-primary">
          {editing ? `Edit ${editing.assetTag}` : isPeripheral ? "New peripheral asset" : "New asset"}
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {!editing && (
            <label className="col-span-2 text-xs text-ink-secondary">
              Asset tag
              <input
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                placeholder="auto-generated if left blank"
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              />
            </label>
          )}

          {!editing && (
            <label className="col-span-2 text-xs text-ink-secondary">
              Asset type
              <select
                value={assetType}
                onChange={(e) => setAssetType(e.target.value as AssetType)}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="computer">Computer (linked to an agent)</option>
                <option value="peripheral">Peripheral (monitor, printer, ...)</option>
              </select>
            </label>
          )}

          {isPeripheral ? (
            parentAgentId && (
              <p className="col-span-2 text-xs text-ink-muted">
                Connected via <span className="font-medium text-ink-secondary">{parentAgentId}</span> at registration
              </p>
            )
          ) : (
            <label className="col-span-2 text-xs text-ink-secondary">
              Linked device
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Not linked to a device</option>
                {linkableAgents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="text-xs text-ink-secondary">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AssetStatus)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {isPeripheral && (
            <>
              <label className="text-xs text-ink-secondary">
                Brand
                <input
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                />
              </label>
              <label className="text-xs text-ink-secondary">
                Model
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                />
              </label>
            </>
          )}

          <label className="col-span-2 text-xs text-ink-secondary">
            {isPeripheral ? "Serial number" : "Serial number (for matching)"}
            <input
              value={manualSerialNumber}
              onChange={(e) => setManualSerialNumber(e.target.value)}
              placeholder={
                isPeripheral
                  ? "from the device's EDID, or type it in by hand"
                  : "e.g. from the purchase order — links this asset automatically once a device with this serial connects"
              }
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Category
            <input value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="text-xs text-ink-secondary">
            Location
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="text-xs text-ink-secondary">
            Order number
            <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="col-span-2 text-xs text-ink-secondary">
            Checked out to
            <input value={checkedOutTo} onChange={(e) => setCheckedOutTo(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="text-xs text-ink-secondary">
            Checkout date
            <input type="date" value={checkoutDate} onChange={(e) => setCheckoutDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="text-xs text-ink-secondary">
            Expected check-in
            <input type="date" value={expectedCheckinDate} onChange={(e) => setExpectedCheckinDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="text-xs text-ink-secondary">
            End of life
            <input type="date" value={eolDate} onChange={(e) => setEolDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
          </label>

          <label className="col-span-2 text-xs text-ink-secondary">
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
