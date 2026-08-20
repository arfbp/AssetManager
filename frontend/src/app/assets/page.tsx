"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { ProcessManagerDrawer } from "@/components/process/ProcessManagerDrawer";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { ImportAssetsModal } from "@/components/assets/ImportAssetsModal";
import { ConnectionHistoryModal } from "@/components/assets/ConnectionHistoryModal";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { StatusBadge } from "@/components/status/StatusBadge";
import { Button } from "@/components/ui/Button";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { getAssets, getFleetLocations, deleteAsset, getAssetModels, getCustomFieldLabels, getVendors, getEmployees, ApiError } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import { formatRelativeTime } from "@/lib/format";
import { toCsv } from "@/lib/csv";
import type { AssetInput, AssetWithLiveInfo, AssetStatus, DeviceInfo, DeviceLocationEntry, AssetModel, CustomFieldLabels, Vendor, Employee } from "@/lib/types";

// export แบบ fixed-asset-register จริง ๆ — มีทุก field ที่ custodian/auditor
// ต้องการ (vendor, PO, ข้อมูล depreciation, สถานะ maintenance/license) ไม่ใช่
// แค่ column ของ device-inventory เดิม ตั้งใจไม่ใส่ disposal เป็น column
// เพราะมันเป็น record แยกที่มีหน้าของตัวเอง (/asset-retirements) —
// `Status = retired` คือสัญญาณระดับ register อยู่แล้ว
function exportAssetsCsv(assets: AssetWithLiveInfo[]): void {
  const rows: string[][] = [
    [
      "Asset Tag", "Status", "Category", "Asset Model", "Manufacturer", "Model", "Serial",
      "Location", "Checked Out To", "Department", "Vendor", "PO Number", "Purchase Date",
      "Purchase Cost", "Depreciation Years", "Salvage Value", "Book Value",
      "Warranty Expiry", "Next Maintenance", "Licenses", "End of Life",
    ],
  ];
  for (const a of assets) {
    rows.push([
      a.assetTag,
      a.status,
      a.category ?? "",
      a.assetModelName ?? "",
      a.manufacturer ?? "",
      a.model ?? "",
      a.serialNumber ?? "",
      a.location ?? "",
      a.checkedOutTo ?? "",
      a.checkedOutToDepartment ?? "",
      a.vendorName ?? "",
      a.purchaseOrderNumber ?? "",
      a.purchaseDate ?? "",
      a.purchaseCost !== null && a.purchaseCost !== undefined ? a.purchaseCost.toFixed(2) : "",
      a.depreciationYears !== null && a.depreciationYears !== undefined ? String(a.depreciationYears) : "",
      a.salvageValue !== null && a.salvageValue !== undefined ? a.salvageValue.toFixed(2) : "",
      a.currentBookValue !== null ? a.currentBookValue.toFixed(2) : "",
      a.warrantyExpiryDate ?? "",
      a.nextMaintenanceDate ?? "",
      String(a.licenseCount),
      a.eolDate ?? "",
    ]);
  }
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "optifleet-assets.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// `ipAddresses` คือ list ของ address LAN-local ของ device เอง (มาจาก
// ip_addresses ใน last_telemetry — ค่าเดียวกับที่ network tab ของหน้า device
// detail แสดง) คนละอย่างกับ geolocation ด้านล่างที่ resolve จาก public IP
// ทั้งสองค่า "จริง" ทั้งคู่ แค่ตัวหนึ่งไม่มีประโยชน์กับคำถาม "เครื่องนี้อยู่
// ที่ไหนจริง ๆ" อีกตัวมี
function ipLabel(asset: AssetWithLiveInfo): string {
  const ips = asset.ipAddresses ?? [];
  const first = ips[0];
  if (!first) return "—";
  return ips.length > 1 ? `${first} (+${ips.length - 1})` : first;
}

// City/country จาก IP geolocation — ใช้ source เดียวกันและมีข้อจำกัดเดียวกัน
// กับหน้า Live Tracking (server/src/geolocation/ipGeo.ts): address แบบ
// private/LAN resolve เป็นตำแหน่งไม่ได้เลย และแม้แต่ public IP จริง ๆ
// ก็ได้แค่พิกัดโซนของ ISP คร่าว ๆ ไม่ใช่ตำแหน่งที่แม่นยำ
function geoLabel(loc: DeviceLocationEntry | undefined): string {
  if (!loc) return "—";
  if (loc.isPrivate) return "Private network";
  const place = [loc.city, loc.country].filter(Boolean).join(", ");
  return place || "—";
}

// หนึ่ง chip ต่อหนึ่ง physical drive — "224 GB SSD", "1863 GB HDD" — ข้อมูล
// spec ชุดเดียวกับที่ panel "Specs" ใน device drawer แสดง แค่ย่อให้พอดีกับ
// table cell media type ที่เป็น "Unknown" (OS รายงาน SSD/HDD ไม่ชัดเจน)
// ก็ยังโชว์ขนาดอยู่ ไม่ซ่อนไปเลย
function storageLabel(asset: AssetWithLiveInfo): string {
  const disks = asset.physicalDisks ?? [];
  if (disks.length === 0) return "—";
  return disks.map((d) => `${d.size_gb.toFixed(0)} GB ${d.media_type}`).join(", ");
}

const STATUS_LABEL: Record<AssetStatus, string> = {
  ready_to_deploy: "Ready to deploy",
  deployed: "Deployed",
  in_repair: "In repair",
  retired: "Retired",
};

// แสดงเฉพาะใน cell "Linked device" ของ asset ประเภท "peripheral" เท่านั้น
// lastConnectionAgentId เป็น null แปลว่ายังไม่เคยเห็นมันเชื่อมต่อกับอะไรเลย
// จริง ๆ (การตั้ง parentAgentId ตอน register ด้วยมือไม่นับ) — "ถ้าไม่เคย
// connect ก็ไม่ต้องโชว์อะไร" ส่วนกรณีอื่นจะแยกให้ชัดระหว่าง "connect อยู่
// ตอนนี้" กับ "เคย connect ไว้เมื่อไหร่" แทนที่จะอ่านเป็น present-tense
// ตลอด
function ConnectionSummary({ asset }: { asset: AssetWithLiveInfo }) {
  if (!asset.lastConnectionAgentId || !asset.lastConnectedAt) {
    return <span className="text-ink-muted">—</span>;
  }
  const isCurrent = !asset.lastConnectionDisconnectedAt;
  return (
    <span className="text-xs text-ink-secondary">
      {isCurrent ? "Connected to " : "Last connected to "}
      <span className="font-medium text-ink-primary">{asset.lastConnectionAgentId}</span>
      <span className="text-ink-muted"> · {formatRelativeTime(new Date(asset.lastConnectedAt).getTime())}</span>
    </span>
  );
}

// book value แบบ straight-line คำนวณฝั่ง server (assets/depreciation.ts) —
// เป็น null เมื่อ purchaseCost/purchaseDate/depreciationYears ไม่ครบทั้งสาม
// ค่า ใช้แนวทางเดียวกับ column optional อื่น ๆ ในหน้านี้คือโชว์แค่ขีดกลาง
// ไม่ใช่ error
function bookValueLabel(asset: AssetWithLiveInfo): string {
  return asset.currentBookValue === null ? "—" : `$${asset.currentBookValue.toFixed(2)}`;
}

// เป็นสีแดงเมื่อ maintenance record ที่กำหนดไว้เร็วที่สุดเลยกำหนดแล้ว —
// ใช้แนวทางเดียวกับ maintenanceStore.ts คือ derive overdue จากวันที่ปัจจุบัน
// ไม่เก็บเป็น flag แยก title มีตัวนับ open count ติดไปด้วยเลยไม่ต้องมี
// column แยกสำหรับ "3 scheduled"
function MaintenanceDueCell({ asset }: { asset: AssetWithLiveInfo }) {
  if (!asset.nextMaintenanceDate) return <span className="text-ink-muted">—</span>;
  const overdue = asset.nextMaintenanceDate.slice(0, 10) < new Date().toISOString().slice(0, 10);
  return (
    <span className={overdue ? "text-status-critical" : "text-ink-secondary"} title={`${asset.openMaintenanceCount} scheduled`}>
      {asset.nextMaintenanceDate.slice(0, 10)}
    </span>
  );
}

// "Checked out to" พร้อม contact field เสริมสองอย่าง — email/department
// จะ render เป็นตัวหนังสือ muted รองใต้ชื่อ ใช้ style เดียวกับ metadata
// รองอื่น ๆ ในหน้านี้ (เช่น relative time ของ ConnectionSummary) ไม่ใช่
// pattern ใหม่
// เลือกใช้ชื่อจาก live directory (checkedOutToEmployeeName) ก่อน snapshot
// ณ เวลานั้น (checkedOutTo) เมื่อมีทั้งคู่ — ถ้า rename ใน directory จะ
// เห็นผลใน list นี้ทันที แต่ snapshot เองจะ freeze ไว้เพื่อประวัติ/การพิมพ์
// จะ link ไปหน้า employee ก็ต่อเมื่อมี directory link จริงเท่านั้น
function CheckoutCell({ asset }: { asset: AssetWithLiveInfo }) {
  const name = asset.checkedOutToEmployeeName ?? asset.checkedOutTo;
  if (!name) return <span className="text-ink-secondary">—</span>;
  const contact = [asset.checkedOutToEmail, asset.checkedOutToDepartment].filter(Boolean).join(" · ");
  return (
    <div>
      {asset.checkedOutToEmployeeId ? (
        <Link href={`/employees/${asset.checkedOutToEmployeeId}`} className="text-ink-secondary hover:underline">
          {name}
        </Link>
      ) : (
        <p className="text-ink-secondary">{name}</p>
      )}
      {contact && <p className="text-xs text-ink-muted">{contact}</p>}
    </div>
  );
}

function AssetsPage({ username }: { username: string }) {
  // ฝั่ง server ปฏิเสธการเขียนของ viewer พร้อม message ชัดเจนอยู่แล้ว
  // (ทุก path save/delete ในนี้ catch ApiError แล้วโชว์ inline) การซ่อนปุ่มนี้
  // แค่ป้องกันไม่ให้แสดงปุ่มที่รู้อยู่แล้วว่าจะ fail แน่ ๆ ไม่ใช่ security
  // boundary จริงจัง
  const canWrite = getStoredRole() !== "viewer";
  const router = useRouter();
  const { agents, history, commandOutputs, connectionStatus } = useDashboardSocket();
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [unregisteredAgents, setUnregisteredAgents] = useState<string[]>([]);
  const [locations, setLocations] = useState<DeviceLocationEntry[]>([]);
  const [assetModels, setAssetModels] = useState<AssetModel[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [customFieldLabels, setCustomFieldLabels] = useState<CustomFieldLabels | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [requestableOnly, setRequestableOnly] = useState(false);
  const [maintenanceDueOnly, setMaintenanceDueOnly] = useState(false);
  const [vendorFilter, setVendorFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [scanValue, setScanValue] = useState("");
  const [editing, setEditing] = useState<AssetWithLiveInfo | "new" | null>(null);
  const [prefill, setPrefill] = useState<AssetInput | undefined>(undefined);
  const [showImport, setShowImport] = useState(false);
  const [viewingDevicesFor, setViewingDevicesFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetWithLiveInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // asset ประเภท "computer" ตัวไหนที่ขยายไว้เพื่อโชว์ peripheral ที่เชื่อมอยู่
  // (จอมอนิเตอร์ ฯลฯ) ซ้อนอยู่ข้างล่าง — key ด้วย asset tag
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [historyTarget, setHistoryTarget] = useState<string | null>(null);

  function toggleExpand(tag: string): void {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function handleRegisterDevice(device: DeviceInfo, agentId: string): void {
    setPrefill({
      assetType: "peripheral",
      manufacturer: device.manufacturer || null,
      model: device.model || device.name,
      manualSerialNumber: device.serial_number || null,
      parentAgentId: agentId,
      status: "deployed",
    });
    setEditing("new");
  }

  function reload(): void {
    setLoading(true);
    getAssets()
      .then((res) => {
        setAssets(res.assets);
        setUnregisteredAgents(res.unregisteredAgents);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load assets."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    getFleetLocations()
      .then((res) => setLocations(res.devices))
      .catch(() => setLocations([])); // best-effort — ถ้าพลาดแถว asset จะโชว์ "—" สำหรับ city/country
  }, []);

  useEffect(() => {
    getAssetModels()
      .then((res) => setAssetModels(res.assetModels))
      .catch(() => setAssetModels([]));
    getCustomFieldLabels()
      .then((res) => setCustomFieldLabels(res.labels))
      .catch(() => setCustomFieldLabels(undefined));
    getVendors()
      .then((res) => setVendors(res.vendors))
      .catch(() => setVendors([]));
    getEmployees()
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
  }, []);

  // เครื่องสแกนบาร์โค้ดแบบมือถือจะพิมพ์ text ที่สแกนได้เข้า input ที่ focus
  // อยู่แล้วกด Enter ให้เอง — input นี้คือ "barcode scanner integration"
  // ทั้งหมด: เล็ง scanner มาที่ field นี้ สแกน แล้วมันจะพาไปหน้า detail ของ
  // asset นั้นทันที พิมพ์ asset tag เองแล้วกด Enter ก็ทำงานเหมือนกันทุก
  // ประการ
  function handleScanSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const tag = scanValue.trim();
    if (!tag) return;
    setScanValue("");
    router.push(`/assets/${encodeURIComponent(tag)}`);
  }

  const locationByAgentId = new Map(locations.map((l) => [l.agentId, l]));

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteAsset(deleteTarget.assetTag);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to delete asset.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const filtered = assets.filter((a) => {
    if (requestableOnly && !a.isRequestable) return false;
    if (maintenanceDueOnly && !a.nextMaintenanceDate) return false;
    if (vendorFilter && a.vendorId !== vendorFilter) return false;
    if (modelFilter && a.assetModelId !== modelFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      a.assetTag.toLowerCase().includes(q) ||
      (a.agentId ?? "").toLowerCase().includes(q) ||
      (a.serialNumber ?? "").toLowerCase().includes(q) ||
      (a.manufacturer ?? "").toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q) ||
      (a.location ?? "").toLowerCase().includes(q) ||
      (a.category ?? "").toLowerCase().includes(q) ||
      (a.checkedOutTo ?? "").toLowerCase().includes(q) ||
      (a.checkedOutToEmployeeName ?? "").toLowerCase().includes(q) ||
      (a.vendorName ?? "").toLowerCase().includes(q) ||
      (a.assetModelName ?? "").toLowerCase().includes(q) ||
      (a.purchaseOrderNumber ?? "").toLowerCase().includes(q)
    );
  });

  const viewingAgent = agents.find((a) => a.agentId === viewingDevicesFor) ?? null;

  // asset ประเภท "computer" (เชื่อมกับ agent_id) แต่ละตัวจะมี asset ประเภท
  // "peripheral" (เช่นจอมอนิเตอร์ที่ register ด้วย SN ของตัวเอง) ซ้อนอยู่
  // ข้างล่าง เปิด/ปิดได้ด้วยปุ่ม +/- — parentAgentId ของ peripheral บันทึกไว้
  // ว่าตอน register เชื่อมกับ computer ตัวไหน ส่วน peripheral ที่ parent
  // ไม่ใช่ (หรือไม่ใช่แล้ว) computer asset ที่ register ไว้ ก็ยังต้องโชว์อยู่
  // ที่ไหนสักที่ เลย fallback กลับไปเป็นแถว top-level ของตัวเองแทนที่จะ
  // หายไปเงียบ ๆ
  const computerAssets = filtered.filter((a) => a.assetType !== "peripheral");
  const peripheralAssets = filtered.filter((a) => a.assetType === "peripheral");
  const computerAgentIds = new Set(computerAssets.map((c) => c.agentId).filter((id): id is string => Boolean(id)));
  const orphanPeripherals = peripheralAssets.filter((p) => !p.parentAgentId || !computerAgentIds.has(p.parentAgentId));
  const childrenByParent = new Map<string, AssetWithLiveInfo[]>();
  for (const p of peripheralAssets) {
    if (!p.parentAgentId || !computerAgentIds.has(p.parentAgentId)) continue;
    const list = childrenByParent.get(p.parentAgentId) ?? [];
    list.push(p);
    childrenByParent.set(p.parentAgentId, list);
  }

  // ส่งเข้า list "Connected devices" ของ ProcessManagerDrawer เพื่อซ่อนปุ่ม
  // "+ Add as asset" สำหรับ device ที่มี asset record อยู่แล้ว — สร้างจาก
  // list เต็ม (ไม่ filter) ไม่ใช่ `filtered` เพื่อไม่ให้พิมพ์ในช่องค้นหาแล้ว
  // ปุ่มของ device ที่ register ไปแล้วโผล่กลับมา
  const registeredSerials = new Set(assets.map((a) => a.serialNumber).filter((s): s is string => Boolean(s)));

  return (
    <AppShell
      username={username}
      connectionStatus={connectionStatus}
      statusSlot={
        <StatusBadge
          tone={connectionStatus === "open" ? "good" : "critical"}
          label={connectionStatus === "open" ? "Live" : connectionStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      }
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Asset Registry</h1>
          <p className="text-xs text-ink-muted">Inventory records, linked to live device data where available.</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Total fleet book value</p>
          <p className="text-lg font-bold text-ink-primary">
            ${assets.reduce((sum, a) => sum + (a.currentBookValue ?? 0), 0).toFixed(2)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search asset tag, device, serial, model, location…"
            className="w-full max-w-sm rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
          />
          <form onSubmit={handleScanSubmit}>
            <input
              value={scanValue}
              onChange={(e) => setScanValue(e.target.value)}
              placeholder="Scan or enter asset tag…"
              className="w-56 rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </form>
          <button
            type="button"
            onClick={() => setRequestableOnly((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              requestableOnly ? "border-accent bg-accent/10 text-accent" : "border-border text-ink-secondary hover:bg-gridline/40"
            }`}
          >
            Requestable only
          </button>
          <button
            type="button"
            onClick={() => setMaintenanceDueOnly((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              maintenanceDueOnly ? "border-accent bg-accent/10 text-accent" : "border-border text-ink-secondary hover:bg-gridline/40"
            }`}
          >
            Maintenance due
          </button>
          {vendors.length > 0 && (
            <select
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
          {assetModels.length > 0 && (
            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All models</option>
              {assetModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {unregisteredAgents.length > 0 && (
            <span className="text-xs text-ink-muted">{unregisteredAgents.length} connected device(s) not yet registered</span>
          )}
          {assets.length > 0 && (
            <Button variant="secondary" icon="download" onClick={() => exportAssetsCsv(filtered)}>
              Export CSV
            </Button>
          )}
          {canWrite && (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-gridline/40"
            >
              Import
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              onClick={() => {
                setPrefill(undefined);
                setEditing("new");
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              New asset
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[2400px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Asset tag</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Linked device</th>
              <th className="px-4 py-3 font-medium">Serial</th>
              <th className="px-4 py-3 font-medium">Manufacturer</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Asset model</th>
              <th className="px-4 py-3 font-medium">CPU</th>
              <th className="px-4 py-3 font-medium">Storage</th>
              <th className="px-4 py-3 font-medium">IP address</th>
              <th className="px-4 py-3 font-medium">City / Country</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Checked out to</th>
              <th className="px-4 py-3 font-medium">Vendor</th>
              <th className="px-4 py-3 font-medium">PO</th>
              <th className="px-4 py-3 font-medium">Maintenance due</th>
              <th className="px-4 py-3 font-medium">Licenses</th>
              <th className="px-4 py-3 font-medium">End of life</th>
              <th className="px-4 py-3 font-medium">Warranty</th>
              <th className="px-4 py-3 font-medium">Book value</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={22} className="px-4 py-6 text-center text-ink-muted">
                  Loading…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={22} className="px-4 py-6 text-center text-status-critical">
                  {error}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={22} className="px-4 py-6 text-center text-ink-muted">
                  No assets registered yet.
                </td>
              </tr>
            ) : (
              computerAssets.flatMap((asset) => {
                const children = asset.agentId ? childrenByParent.get(asset.agentId) ?? [] : [];
                const expanded = expandedTags.has(asset.assetTag);
                const rows = [
                  <tr key={asset.assetTag} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-primary">
                      <span className="flex items-center gap-1.5">
                        {children.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(asset.assetTag)}
                            aria-label={expanded ? "Collapse linked peripherals" : "Expand linked peripherals"}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[11px] leading-none text-ink-secondary hover:bg-gridline/40"
                          >
                            {expanded ? "−" : "+"}
                          </button>
                        ) : (
                          <span className="inline-block w-4 shrink-0" />
                        )}
                        <Link href={`/assets/${encodeURIComponent(asset.assetTag)}`} className="hover:underline">
                          {asset.assetTag}
                        </Link>
                        {asset.isRequestable && (
                          <span className="material-symbols-outlined text-[14px] text-accent" title="Requestable">
                            pan_tool
                          </span>
                        )}
                        {asset.pendingRequestCount > 0 && (
                          <span
                            className="material-symbols-outlined text-[14px] text-status-warning"
                            title={`${asset.pendingRequestCount} pending request(s)`}
                          >
                            pending_actions
                          </span>
                        )}
                        {children.length > 0 && (
                          <span className="text-[11px] font-normal text-ink-muted">
                            ({children.length} peripheral{children.length === 1 ? "" : "s"})
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                        {STATUS_LABEL[asset.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {asset.agentId ? (
                        <span className="flex items-center gap-1.5">
                          <StatusBadge tone={asset.liveStatus === "online" ? "good" : "offline"} label={asset.agentId} />
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.serialNumber || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.manufacturer || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.model || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.assetModelName || "—"}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-ink-secondary" title={asset.cpuModel || undefined}>
                      {asset.cpuModel || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{storageLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{ipLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">
                      {asset.agentId ? geoLabel(locationByAgentId.get(asset.agentId)) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.location || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.category || "—"}</td>
                    <td className="px-4 py-3 text-sm"><CheckoutCell asset={asset} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.vendorName || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">
                      {asset.purchaseOrderNumber ? (
                        <Link href="/purchase-orders" className="hover:underline">
                          {asset.purchaseOrderNumber}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm"><MaintenanceDueCell asset={asset} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.licenseCount || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.eolDate ? asset.eolDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.warrantyExpiryDate ? asset.warrantyExpiryDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{bookValueLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex gap-1.5">
                        {asset.agentId && (
                          <button
                            type="button"
                            onClick={() => setViewingDevicesFor(asset.agentId ?? null)}
                            disabled={!viewingAgent && asset.liveStatus !== "online"}
                            className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40 disabled:opacity-40"
                            title={asset.liveStatus === "online" ? "View connected devices & processes" : "Device is offline"}
                          >
                            Devices
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(asset)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(asset);
                          }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>,
                ];

                if (expanded) {
                  for (const child of children) {
                    rows.push(
                      <tr key={child.assetTag} className="border-b border-border bg-page/60 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 pl-10 text-ink-secondary">
                          <span className="text-ink-muted">↳</span>{" "}
                          <Link href={`/assets/${encodeURIComponent(child.assetTag)}`} className="hover:underline">
                            {child.assetTag}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                            {STATUS_LABEL[child.status]}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <ConnectionSummary asset={child} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.serialNumber || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.manufacturer || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.model || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.assetModelName || "—"}</td>
                        {/* peripheral ไม่มี CPU/storage/network เป็นของตัวเอง — ค่าพวกนี้ใช้ได้กับ computer ที่มันเสียบอยู่เท่านั้น */}
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.location || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.category || "—"}</td>
                        <td className="px-4 py-2 text-sm"><CheckoutCell asset={child} /></td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.vendorName || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">
                          {child.purchaseOrderNumber ? (
                            <Link href="/purchase-orders" className="hover:underline">
                              {child.purchaseOrderNumber}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-sm"><MaintenanceDueCell asset={child} /></td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.licenseCount || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.eolDate ? child.eolDate.slice(0, 10) : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.warrantyExpiryDate ? child.warrantyExpiryDate.slice(0, 10) : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{bookValueLabel(child)}</td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => setHistoryTarget(child.assetTag)}
                              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                              title="View which computers this was connected through over time"
                            >
                              History
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(child)}
                              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setDeleteTarget(child);
                              }}
                              className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>,
                    );
                  }
                }

                return rows;
              })
            )}
            {!loading && !error && filtered.length > 0 && orphanPeripherals.length > 0 && (
              <>
                <tr className="border-b border-border">
                  <td colSpan={22} className="bg-page/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    Peripherals not linked to a registered computer asset
                  </td>
                </tr>
                {orphanPeripherals.map((asset) => (
                  <tr key={asset.assetTag} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-primary">
                      <Link href={`/assets/${encodeURIComponent(asset.assetTag)}`} className="hover:underline">
                        {asset.assetTag}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                        {STATUS_LABEL[asset.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">
                      {asset.lastConnectionAgentId && agents.some((a) => a.agentId === asset.lastConnectionAgentId) ? (
                        <button
                          type="button"
                          onClick={() => setViewingDevicesFor(asset.lastConnectionAgentId)}
                          className="text-accent underline-offset-2 hover:underline"
                          title="View this device"
                        >
                          <ConnectionSummary asset={asset} />
                        </button>
                      ) : (
                        <ConnectionSummary asset={asset} />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.serialNumber || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.manufacturer || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.model || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.assetModelName || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.location || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.category || "—"}</td>
                    <td className="px-4 py-3 text-sm"><CheckoutCell asset={asset} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.vendorName || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">
                      {asset.purchaseOrderNumber ? (
                        <Link href="/purchase-orders" className="hover:underline">
                          {asset.purchaseOrderNumber}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm"><MaintenanceDueCell asset={asset} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.licenseCount || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.eolDate ? asset.eolDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.warrantyExpiryDate ? asset.warrantyExpiryDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{bookValueLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setHistoryTarget(asset.assetTag)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                          title="View which computers this was connected through over time"
                        >
                          History
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(asset)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(asset);
                          }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <AssetFormModal
          editing={editing === "new" ? null : editing}
          prefill={editing === "new" ? prefill : undefined}
          unregisteredAgents={unregisteredAgents}
          knownCheckoutNames={Array.from(new Set(assets.map((a) => a.checkedOutTo).filter((n): n is string => !!n)))}
          assetModels={assetModels}
          vendors={vendors}
          employees={employees}
          customFieldLabels={customFieldLabels}
          onClose={() => {
            setEditing(null);
            setPrefill(undefined);
          }}
          onSaved={() => {
            setEditing(null);
            setPrefill(undefined);
            reload();
          }}
        />
      )}

      {showImport && (
        <ImportAssetsModal
          onClose={() => setShowImport(false)}
          onImported={reload}
        />
      )}

      </div>

      <ProcessManagerDrawer
        open={viewingDevicesFor !== null}
        agent={viewingAgent}
        agents={agents}
        history={history}
        onClose={() => setViewingDevicesFor(null)}
        onRegisterDevice={(device, agent) => handleRegisterDevice(device, agent.agentId)}
        registeredSerials={registeredSerials}
        commandOutputs={commandOutputs}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this asset?"
        message={
          deleteTarget
            ? `Delete asset ${deleteTarget.assetTag}?${deleteError ? `\n\n${deleteError}` : "\n\nThis only removes the inventory record, not the device itself."}`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {historyTarget && <ConnectionHistoryModal assetTag={historyTarget} onClose={() => setHistoryTarget(null)} />}
    </AppShell>
  );
}

export default function AssetsPageWrapper() {
  return <AuthGate>{(username) => <AssetsPage username={username} />}</AuthGate>;
}
