"use client";

import { useState, type FormEvent } from "react";
import { createAsset, updateAsset, ApiError } from "@/lib/api";
import type { AssetInput, AssetStatus, AssetType, AssetWithLiveInfo, AssetModel, CustomFieldLabels, Vendor, Employee } from "@/lib/types";

const MANUAL_EMPLOYEE = "__manual__";

const STATUS_OPTIONS: { value: AssetStatus; label: string }[] = [
  { value: "ready_to_deploy", label: "Ready to deploy" },
  { value: "deployed", label: "Deployed" },
  { value: "in_repair", label: "In repair" },
  { value: "retired", label: "Retired" },
];

interface AssetFormModalProps {
  // มีค่าตอนแก้ไข asset ที่มีอยู่แล้ว ไม่มีค่าตอนสร้างใหม่
  editing: AssetWithLiveInfo | null;
  // ค่าเริ่มต้นสำหรับ asset ใหม่ — ใช้โดย flow "ลงทะเบียนอุปกรณ์ที่ต่ออยู่
  // นี้เป็น asset" (รายการอุปกรณ์ต่อพ่วงใน ProcessManagerDrawer) เพื่อ
  // กรอกยี่ห้อ/รุ่น/serial ให้ล่วงหน้า แทนที่จะให้ผู้ใช้พิมพ์เอง ไม่มีผล
  // เมื่อตั้งค่า `editing` ไว้แล้ว
  prefill?: AssetInput;
  // hostname ของอุปกรณ์ที่เชื่อมต่ออยู่แต่ยังไม่มี record asset — เสนอเป็น
  // ตัวเลือกด่วนสำหรับ "เชื่อมกับอุปกรณ์" แทนที่จะให้ผู้ใช้พิมพ์ hostname
  // จากความจำ
  unregisteredAgents: string[];
  // ชื่อ "เบิกไปที่" ที่ต่างกันซึ่งเคยใช้อยู่แล้วในรายการ asset ของ org
  // นี้ — เสนอเป็น autocomplete แบบ <datalist> ในช่องชื่อด้านล่าง มาจาก
  // ข้อมูลที่ฝั่งเรียกใช้โหลดมาแล้วล้วนๆ (ไม่ query backend เพิ่ม) ไม่ใช่
  // directory พนักงานจริง
  knownCheckoutNames?: string[];
  // template ที่ใช้ซ้ำได้ — เลือกแล้วจะกรอกยี่ห้อ/รุ่น/หมวดหมู่/ค่าเสื่อม
  // ให้ครั้งเดียวด้านล่าง (ดู handleModelSelect) หลังจากนั้นจะไม่ sync
  // ตามอีก เหมือนกับ prefill ตอนลงทะเบียนอุปกรณ์ต่อพ่วง
  assetModels?: AssetModel[];
  // ผู้จำหน่ายที่ org นี้มีบันทึกไว้ — เป็นแค่ลิงก์ข้อมูลที่เก็บไว้ธรรมดา
  // ต่างจาก assetModels ด้านบนที่กรอกให้ครั้งเดียว แสดงทั้งตอนสร้างและ
  // แก้ไข เพราะการแก้ vendor ของ asset ทีหลังเป็นงานปกติของทะเบียน
  // fixed asset
  vendors?: Vendor[];
  // ใช้ขับเคลื่อนตัวเลือกพนักงาน "เบิกไปที่" ด้านล่าง แทนที่/เสริมช่อง
  // กรอกชื่อแบบ free-text เดิม
  employees?: Employee[];
  // render เฉพาะ field ที่มี label ไม่เป็น null เท่านั้น — org ที่ยังไม่
  // ได้ตั้งค่า custom field เลยจะไม่เห็นส่วนนี้เลย
  customFieldLabels?: CustomFieldLabels;
  onClose: () => void;
  onSaved: () => void;
}

export function AssetFormModal({
  editing,
  prefill,
  unregisteredAgents,
  knownCheckoutNames = [],
  assetModels = [],
  vendors = [],
  employees = [],
  customFieldLabels,
  onClose,
  onSaved,
}: AssetFormModalProps) {
  const base = editing ?? prefill;
  const [assetTag, setAssetTag] = useState(editing?.assetTag ?? "");
  const [assetType, setAssetType] = useState<AssetType>(base?.assetType ?? "computer");
  const [agentId, setAgentId] = useState(editing?.agentId ?? "");
  const [status, setStatus] = useState<AssetStatus>(base?.status ?? "ready_to_deploy");
  const [category, setCategory] = useState(base?.category ?? "");
  const [location, setLocation] = useState(base?.location ?? "");
  const [orderNumber, setOrderNumber] = useState(base?.orderNumber ?? "");
  const [checkedOutTo, setCheckedOutTo] = useState(base?.checkedOutTo ?? "");
  const [checkedOutToEmail, setCheckedOutToEmail] = useState(base?.checkedOutToEmail ?? "");
  const [checkedOutToDepartment, setCheckedOutToDepartment] = useState(base?.checkedOutToDepartment ?? "");
  const [checkoutDate, setCheckoutDate] = useState(base?.checkoutDate?.slice(0, 10) ?? "");
  const [expectedCheckinDate, setExpectedCheckinDate] = useState(base?.expectedCheckinDate?.slice(0, 10) ?? "");
  const [eolDate, setEolDate] = useState(base?.eolDate?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(base?.notes ?? "");
  const [manualSerialNumber, setManualSerialNumber] = useState(base?.manualSerialNumber ?? "");
  const [manufacturer, setManufacturer] = useState(base?.manufacturer ?? "");
  const [model, setModel] = useState(base?.model ?? "");
  const [purchaseCost, setPurchaseCost] = useState(base?.purchaseCost !== null && base?.purchaseCost !== undefined ? String(base.purchaseCost) : "");
  const [purchaseDate, setPurchaseDate] = useState(base?.purchaseDate?.slice(0, 10) ?? "");
  const [depreciationYears, setDepreciationYears] = useState(
    base?.depreciationYears !== null && base?.depreciationYears !== undefined ? String(base.depreciationYears) : "",
  );
  const [salvageValue, setSalvageValue] = useState(base?.salvageValue !== null && base?.salvageValue !== undefined ? String(base.salvageValue) : "");
  const [warrantyExpiryDate, setWarrantyExpiryDate] = useState(base?.warrantyExpiryDate?.slice(0, 10) ?? "");
  const [assetModelId, setAssetModelId] = useState(base?.assetModelId ?? "");
  const [vendorId, setVendorId] = useState(base?.vendorId ?? "");
  // ควบคุมแบบ 3 สถานะสำหรับ "เบิกไปที่": เป็น employee id จริง,
  // MANUAL_EMPLOYEE สำหรับ "คนที่ไม่มีใน directory" หรือ "" (ยังไม่ได้
  // เบิก) เริ่มที่ MANUAL_EMPLOYEE เมื่อมีชื่อแบบ free-text อยู่แล้วโดยไม่
  // มี id ที่ตรงกัน (ข้อมูลเก่า) หรือ directory ว่างเปล่า เพื่อให้ค่าเดิม
  // ยังเห็นและแก้ไขได้ ไม่หายไปเฉยๆ
  const [checkedOutToEmployeeId, setCheckedOutToEmployeeId] = useState(
    base?.checkedOutToEmployeeId ?? ((base?.checkedOutTo || employees.length === 0) ? MANUAL_EMPLOYEE : ""),
  );
  const [customField1, setCustomField1] = useState(base?.customField1 ?? "");
  const [customField2, setCustomField2] = useState(base?.customField2 ?? "");
  const [customField3, setCustomField3] = useState(base?.customField3 ?? "");
  const [customField4, setCustomField4] = useState(base?.customField4 ?? "");
  const [customField5, setCustomField5] = useState(base?.customField5 ?? "");
  const [isRequestable, setIsRequestable] = useState(base?.isRequestable ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPeripheral = assetType === "peripheral";
  const parentAgentId = editing?.parentAgentId ?? prefill?.parentAgentId ?? null;

  function handleModelSelect(modelId: string): void {
    setAssetModelId(modelId);
    const found = assetModels.find((m) => m.id === modelId);
    if (!found) return;
    if (found.category) setCategory(found.category);
    if (found.manufacturer) setManufacturer(found.manufacturer);
    if (found.model) setModel(found.model);
    if (found.depreciationYears !== null) setDepreciationYears(String(found.depreciationYears));
    if (found.salvageValue !== null) setSalvageValue(String(found.salvageValue));
  }

  function handleEmployeeSelect(value: string): void {
    setCheckedOutToEmployeeId(value);
    if (value === MANUAL_EMPLOYEE || value === "") {
      if (value === "") {
        setCheckedOutTo("");
        setCheckedOutToEmail("");
        setCheckedOutToDepartment("");
      }
      return;
    }
    const found = employees.find((e) => e.id === value);
    if (!found) return;
    // กรอกให้ครั้งเดียว เหมือน handleModelSelect ด้านบน — สาม field ที่
    // เก็บค่า snapshot นี้ยังแก้ไขได้อิสระหลังจากนั้น ไม่ sync กับข้อมูล
    // ใน directory อีก
    setCheckedOutTo(found.name);
    setCheckedOutToEmail(found.email ?? "");
    setCheckedOutToDepartment(found.departmentName ?? "");
  }

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
      checkedOutToEmail: checkedOutToEmail || null,
      checkedOutToDepartment: checkedOutToDepartment || null,
      checkoutDate: checkoutDate || null,
      expectedCheckinDate: expectedCheckinDate || null,
      eolDate: eolDate || null,
      notes: notes || null,
      manualSerialNumber: manualSerialNumber || null,
      assetType,
      manufacturer: isPeripheral ? manufacturer || null : null,
      model: isPeripheral ? model || null : null,
      parentAgentId: isPeripheral ? parentAgentId : null,
      purchaseCost: purchaseCost === "" ? null : Number(purchaseCost),
      purchaseDate: purchaseDate || null,
      depreciationYears: depreciationYears === "" ? null : Number(depreciationYears),
      salvageValue: salvageValue === "" ? null : Number(salvageValue),
      warrantyExpiryDate: warrantyExpiryDate || null,
      assetModelId: assetModelId || null,
      vendorId: vendorId || null,
      checkedOutToEmployeeId: checkedOutToEmployeeId && checkedOutToEmployeeId !== MANUAL_EMPLOYEE ? checkedOutToEmployeeId : null,
      customField1: customField1 || null,
      customField2: customField2 || null,
      customField3: customField3 || null,
      customField4: customField4 || null,
      customField5: customField5 || null,
      isRequestable,
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

          {!editing && assetModels.length > 0 && (
            <label className="col-span-2 text-xs text-ink-secondary">
              Asset model (optional — prefills fields below)
              <select
                value={assetModelId}
                onChange={(e) => handleModelSelect(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">None</option>
                {assetModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
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

          {vendors.length > 0 && (
            <label className="col-span-2 text-xs text-ink-secondary">
              Vendor
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">None</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {employees.length > 0 && (
            <label className="col-span-2 text-xs text-ink-secondary">
              Checked out to
              <select
                value={checkedOutToEmployeeId}
                onChange={(e) => handleEmployeeSelect(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Not checked out</option>
                {employees
                  .filter((e) => e.status === "active" || e.id === checkedOutToEmployeeId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.departmentName ? ` — ${e.departmentName}` : ""}
                    </option>
                  ))}
                <option value={MANUAL_EMPLOYEE}>Someone not in the directory…</option>
              </select>
            </label>
          )}

          {(checkedOutToEmployeeId === MANUAL_EMPLOYEE || employees.length === 0) && (
            <label className="col-span-2 text-xs text-ink-secondary">
              {employees.length > 0 ? "Name" : "Checked out to"}
              <input
                value={checkedOutTo}
                onChange={(e) => setCheckedOutTo(e.target.value)}
                list="checkout-name-options"
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
              />
              <datalist id="checkout-name-options">
                {knownCheckoutNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
          )}

          <label className="text-xs text-ink-secondary">
            Email
            <input
              type="email"
              value={checkedOutToEmail}
              onChange={(e) => setCheckedOutToEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Department
            <input
              value={checkedOutToDepartment}
              onChange={(e) => setCheckedOutToDepartment(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
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

          <label className="text-xs text-ink-secondary">
            Warranty expiry
            <input
              type="date"
              value={warrantyExpiryDate}
              onChange={(e) => setWarrantyExpiryDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Purchase cost
            <input
              type="number"
              min={0}
              step="0.01"
              value={purchaseCost}
              onChange={(e) => setPurchaseCost(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Purchase date
            <input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Depreciation (years)
            <input
              type="number"
              min={1}
              value={depreciationYears}
              onChange={(e) => setDepreciationYears(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          <label className="text-xs text-ink-secondary">
            Salvage value
            <input
              type="number"
              min={0}
              step="0.01"
              value={salvageValue}
              onChange={(e) => setSalvageValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </label>

          {customFieldLabels?.field1Label && (
            <label className="text-xs text-ink-secondary">
              {customFieldLabels.field1Label}
              <input value={customField1} onChange={(e) => setCustomField1(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
          )}
          {customFieldLabels?.field2Label && (
            <label className="text-xs text-ink-secondary">
              {customFieldLabels.field2Label}
              <input value={customField2} onChange={(e) => setCustomField2(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
          )}
          {customFieldLabels?.field3Label && (
            <label className="text-xs text-ink-secondary">
              {customFieldLabels.field3Label}
              <input value={customField3} onChange={(e) => setCustomField3(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
          )}
          {customFieldLabels?.field4Label && (
            <label className="text-xs text-ink-secondary">
              {customFieldLabels.field4Label}
              <input value={customField4} onChange={(e) => setCustomField4(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
          )}
          {customFieldLabels?.field5Label && (
            <label className="text-xs text-ink-secondary">
              {customFieldLabels.field5Label}
              <input value={customField5} onChange={(e) => setCustomField5(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent" />
            </label>
          )}

          <label className="col-span-2 flex items-center gap-2 text-xs text-ink-secondary">
            <input type="checkbox" checked={isRequestable} onChange={(e) => setIsRequestable(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Requestable — employees can request this asset via self-service
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
