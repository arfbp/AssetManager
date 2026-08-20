// จุดเข้าถึงข้อมูลทะเบียนสินทรัพย์ เก็บข้อมูล inventory/procurement ที่ผู้ควบคุม
// กรอกเอง (ตำแหน่งที่ตั้ง, ใครเป็นคนเบิกไป, เลขที่สั่งซื้อ, วันหมดอายุการใช้งาน)
// — แยกออกจากและซ้อนทับกับสิ่งที่ agent รายงานอัตโนมัติอยู่แล้ว (หมายเลขซีเรียล,
// รุ่น, ผู้ผลิต, สถานะสด) ซึ่งเก็บอยู่ใน JSONB last_telemetry ของตาราง `agents`
// และโมดูลนี้จะ join มาอ่านอย่างเดียวเท่านั้น ไม่มีการเขียนกลับ
//
// ทุกฟังก์ชันรับ orgId เสมอ: agent_id คือ hostname ของ OS เครื่องนั้น ซึ่งไม่ได้
// unique ข้าม organization (ดู doc comment ของ ws/registry.ts) ดังนั้นการ join
// หรือ lookup โดยใช้แค่ agent_id เสี่ยงไปจับคู่กับอุปกรณ์ของ org อื่นที่บังเอิญมี
// hostname ซ้ำกัน การจำกัดขอบเขตด้วย org_id ในไฟล์นี้จึงเป็นทั้งการแก้ความถูกต้อง
// (ในส่วน join ด้านล่าง) และเป็นขอบเขตการมองเห็นข้อมูล (ผู้เรียกเห็นแค่ asset
// ของ org ตัวเองเท่านั้น)
import type { Pool } from "pg";
import type { PhysicalDiskInfo } from "../protocol.js";
import { computeBookValue } from "./depreciation.js";

// asset ประเภท "computer" คือฝั่งที่มี agent_id: manufacturer/model/serial
// ของมันจะมาจาก telemetry สดของ agent ที่เชื่อมโยงอยู่เสมอ ส่วน asset ประเภท
// "peripheral" (เช่น จอมอนิเตอร์) ไม่มีการเชื่อมต่อ telemetry ของตัวเอง จึง
// บันทึกข้อมูลระบุตัวตนไว้ครั้งเดียวตอนลงทะเบียนแล้วเก็บตรง ๆ — ดู column
// comment ใน schema.sql
export type AssetType = "computer" | "peripheral";

export interface AssetRecord {
  assetTag: string;
  agentId: string | null;
  status: string;
  category: string | null;
  location: string | null;
  orderNumber: string | null;
  checkedOutTo: string | null;
  checkedOutToEmail: string | null;
  checkedOutToDepartment: string | null;
  checkoutDate: string | null;
  expectedCheckinDate: string | null;
  eolDate: string | null;
  notes: string | null;
  // กรอกเองสำหรับ asset ประเภท "computer" ที่ลงทะเบียนไว้ก่อนเชื่อมต่อครั้งแรก
  // หรือเป็นซีเรียลจริง (ตัวเดียว) ของ asset ประเภท "peripheral" — ดู column
  // comment ใน schema.sql ต่างจาก serialNumber ใน AssetLiveInfo ที่จะใช้ค่านี้
  // เป็นแค่ fallback เมื่อไม่มี live telemetry ให้ใช้แทน
  manualSerialNumber: string | null;
  assetType: AssetType;
  // computer เครื่องไหนที่ peripheral ตัวนี้เชื่อมต่ออยู่ตอนลงทะเบียน — เก็บไว้
  // เพื่อข้อมูลอย่างเดียว ไม่มีการอัปเดตให้ตรงกันในภายหลัง เป็น null สำหรับ
  // asset ประเภท "computer"
  parentAgentId: string | null;
  // ข้อมูลค่าเสื่อมราคา/การเงิน — กรอกเองทั้งหมด และเป็น nullable ได้ทั้งหมด
  // (asset ที่ไม่ได้ตั้งค่าพวกนี้เลยจะไม่มี book value ดู currentBookValue
  // ด้านล่าง) purchaseCost/purchaseDate/depreciationYears ต้องตั้งค่าครบทั้ง
  // สามตัวถึงจะคำนวณ book value ได้ ส่วน salvageValue อย่างเดียวถ้าไม่ตั้งค่า
  // จะ default เป็น 0
  purchaseCost: number | null;
  purchaseDate: string | null;
  depreciationYears: number | null;
  salvageValue: number | null;
  warrantyExpiryDate: string | null;
  // แถวไหนใน asset_models (ถ้ามี) ที่ asset นี้ถูกสร้างมาจาก — เก็บไว้เพื่อ
  // ข้อมูลอย่างเดียวเหมือน parentAgentId ด้านบน ค่าของ model จะใช้แค่ prefill
  // ฟอร์มสร้างครั้งเดียว ไม่มีการอัปเดตให้ตรงกันในภายหลัง
  assetModelId: string | null;
  // ที่มาการจัดซื้อแบบมีโครงสร้าง (migrations/0029) ตั้งค่าอัตโนมัติเมื่อ asset
  // ถูกสร้างเป็นชุดจาก PO ที่รับของแล้ว (ดู POST /purchase-orders/:id/receive
  // ใน routes.ts); vendorId ก็แก้ไขเองได้ใน AssetFormModal สำหรับ asset ที่ไม่
  // ได้มาจาก PO
  vendorId: string | null;
  purchaseOrderId: string | null;
  // ลิงก์แบบมีโครงสร้างไปยัง employee directory (migrations/0030) เป็น null
  // สำหรับรายการที่เบิกไปก่อน directory จะมีอยู่ หรือเบิกให้คนที่ตั้งใจไม่ใส่
  // เข้า directory — ในกรณีนั้น checkedOutTo/Email/Department ด้านบนยังคงเป็น
  // จุดอ้างอิงหลัก ณ เวลานั้น
  checkedOutToEmployeeId: string | null;
  // ช่องอเนกประสงค์ 5 ช่องที่ตั้งชื่อเองได้ — ดู assets/customFieldLabels.ts
  // จะแสดงใน UI เฉพาะช่องที่ org ตั้งชื่อไว้แล้วเท่านั้น
  customField1: string | null;
  customField2: string | null;
  customField3: string | null;
  customField4: string | null;
  customField5: string | null;
  // asset นี้ขอเบิกผ่านช่องทาง self-service asset_requests ได้หรือไม่
  // (server/src/assetRequests/assetRequestsStore.ts) — ค่าเริ่มต้นเป็น false
  // ต้องให้ admin เปิดใช้งานทีละ asset เอง
  isRequestable: boolean;
  createdAt: string;
  updatedAt: string;
  // คำนวณแบบ straight-line สดใหม่ทุกครั้งที่อ่าน (assets/depreciation.ts) —
  // ไม่มีการเก็บค่าไว้ จึงไม่มีทางค้างค่าเก่าระหว่างการอ่านแต่ละครั้ง เป็น null
  // เมื่อ input ที่จำเป็น 3 ตัวด้านบนไม่ได้ตั้งค่าครบ
  currentBookValue: number | null;
}

// มุมมองฝั่งอ่าน: สำหรับ asset ประเภท "computer" จะเป็นค่า live telemetry
// เสมอ ส่วน asset ประเภท "peripheral" (ไม่มี telemetry ของตัวเอง) จะ fallback
// ไปใช้ค่าที่เก็บไว้ในแถวตอนลงทะเบียน — ดู COALESCE ใน listAssets
export interface AssetLiveInfo {
  liveStatus: "online" | "offline" | null;
  serialNumber: string | null;
  model: string | null;
  manufacturer: string | null;
  ipAddresses: string[] | null;
  // ทั้งสองค่ามาจาก telemetry snapshot ล่าสุดของ agent ที่เชื่อมโยงอยู่ตรง ๆ
  // เหมือน serialNumber/model/manufacturer ด้านบน — เป็น null สำหรับ asset
  // ประเภท "peripheral" (ไม่มี telemetry ของตัวเอง) หรือถ้า computer ที่
  // เชื่อมโยงอยู่ยังไม่เคยรายงาน snapshot เลย
  cpuModel: string | null;
  physicalDisks: PhysicalDiskInfo[] | null;
  // ช่วงเชื่อมต่อล่าสุดใน asset_connection_history ของ asset ประเภท
  // "peripheral" — เป็น null ทั้งสามฟิลด์ถ้าไม่เคยถูกติดตามว่าเชื่อมต่ออะไร
  // เลยจริง ๆ (ตั้งค่าด้วยมือตอนลงทะเบียนเท่านั้น ไม่เคยได้รับการยืนยันจริง
  // จากสาย) lastConnectionDisconnectedAt จะเป็น null ตราบใดที่ช่วงนั้นยังไม่
  // ปิด (คือกำลังเชื่อมต่ออยู่ *ตอนนี้*)
  lastConnectionAgentId: string | null;
  lastConnectedAt: string | null;
  lastConnectionDisconnectedAt: string | null;
}

// สรุปข้อมูลข้ามโมดูล join/aggregate สดใหม่ทุกครั้งที่ listAssets อ่านข้อมูล
// — ไม่มีการเก็บค่าไว้ แนวทาง "คำนวณสด ไม่ cache" เดียวกับ currentBookValue
// ค่านับทั้งสามตัว COALESCE เป็น 0 ทั้งในฝั่ง SQL *และ* ตั้ง default เป็น 0 ใน
// rowToAsset ด้วย: ค่านับที่ไปถึง frontend เป็น null/undefined คือรูปแบบที่
// เคยสร้างปัญหาให้โค้ดนี้มาแล้ว (array telemetry จาก Go ที่ serialize เป็น
// JSON null แล้วทำให้การอ่าน .length แบบไม่ป้องกันพัง) และค่าพวกนี้ทุกตัวถูก
// render แบบไม่มีการป้องกันในเซลล์ตาราง
export interface AssetErpSummary {
  vendorName: string | null;
  purchaseOrderNumber: string | null;
  assetModelName: string | null;
  checkedOutToEmployeeName: string | null;
  nextMaintenanceDate: string | null;
  openMaintenanceCount: number;
  licenseCount: number;
  pendingRequestCount: number;
}

export type AssetWithLiveInfo = AssetRecord & AssetLiveInfo & AssetErpSummary;

interface AssetRow {
  asset_tag: string;
  agent_id: string | null;
  status: string;
  category: string | null;
  location: string | null;
  order_number: string | null;
  checked_out_to: string | null;
  checked_out_to_email: string | null;
  checked_out_to_department: string | null;
  checkout_date: string | null;
  expected_checkin_date: string | null;
  eol_date: string | null;
  notes: string | null;
  manual_serial_number: string | null;
  asset_type: AssetType;
  parent_agent_id: string | null;
  purchase_cost: string | null; // ค่า NUMERIC จาก pg จะได้กลับมาเป็น string
  purchase_date: string | null;
  depreciation_years: number | null;
  salvage_value: string | null;
  warranty_expiry_date: string | null;
  asset_model_id: string | null;
  vendor_id: string | null;
  purchase_order_id: string | null;
  checked_out_to_employee_id: string | null;
  custom_field_1: string | null;
  custom_field_2: string | null;
  custom_field_3: string | null;
  custom_field_4: string | null;
  custom_field_5: string | null;
  is_requestable: boolean;
  created_at: string;
  updated_at: string;
  live_status?: "online" | "offline" | null;
  serial_number?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  ip_addresses?: string[] | null;
  cpu_model?: string | null;
  physical_disks?: PhysicalDiskInfo[] | null;
  last_connection_agent_id?: string | null;
  last_connected_at?: string | null;
  last_connection_disconnected_at?: string | null;
  // มีค่าเฉพาะจาก joined query ของ listAssets เท่านั้น — `SELECT *` ธรรมดา
  // ของ getAssetByTag ไม่มีทางได้ค่าพวกนี้เลย จึงเป็น optional (ดู default
  // แบบ `??` ใน rowToAsset ด้านล่าง)
  vendor_name?: string | null;
  purchase_order_number?: string | null;
  asset_model_name?: string | null;
  checked_out_to_employee_name?: string | null;
  next_maintenance_date?: string | null;
  open_maintenance_count?: number;
  license_count?: number;
  pending_request_count?: number;
}

function rowToAsset(row: AssetRow): AssetWithLiveInfo {
  const purchaseCost = row.purchase_cost === null ? null : Number(row.purchase_cost);
  const salvageValue = row.salvage_value === null ? null : Number(row.salvage_value);
  return {
    assetTag: row.asset_tag,
    agentId: row.agent_id,
    status: row.status,
    category: row.category,
    location: row.location,
    orderNumber: row.order_number,
    checkedOutTo: row.checked_out_to,
    checkedOutToEmail: row.checked_out_to_email,
    checkedOutToDepartment: row.checked_out_to_department,
    checkoutDate: row.checkout_date,
    expectedCheckinDate: row.expected_checkin_date,
    eolDate: row.eol_date,
    notes: row.notes,
    manualSerialNumber: row.manual_serial_number,
    assetType: row.asset_type,
    parentAgentId: row.parent_agent_id,
    purchaseCost,
    purchaseDate: row.purchase_date,
    depreciationYears: row.depreciation_years,
    salvageValue,
    warrantyExpiryDate: row.warranty_expiry_date,
    assetModelId: row.asset_model_id,
    vendorId: row.vendor_id,
    purchaseOrderId: row.purchase_order_id,
    checkedOutToEmployeeId: row.checked_out_to_employee_id,
    customField1: row.custom_field_1,
    customField2: row.custom_field_2,
    customField3: row.custom_field_3,
    customField4: row.custom_field_4,
    customField5: row.custom_field_5,
    isRequestable: row.is_requestable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentBookValue: computeBookValue(purchaseCost, row.purchase_date, row.depreciation_years, salvageValue),
    liveStatus: row.live_status ?? null,
    serialNumber: row.serial_number ?? null,
    model: row.model ?? null,
    manufacturer: row.manufacturer ?? null,
    ipAddresses: row.ip_addresses ?? null,
    cpuModel: row.cpu_model ?? null,
    physicalDisks: row.physical_disks ?? null,
    lastConnectionAgentId: row.last_connection_agent_id ?? null,
    lastConnectedAt: row.last_connected_at ?? null,
    lastConnectionDisconnectedAt: row.last_connection_disconnected_at ?? null,
    vendorName: row.vendor_name ?? null,
    purchaseOrderNumber: row.purchase_order_number ?? null,
    assetModelName: row.asset_model_name ?? null,
    checkedOutToEmployeeName: row.checked_out_to_employee_name ?? null,
    nextMaintenanceDate: row.next_maintenance_date ?? null,
    openMaintenanceCount: row.open_maintenance_count ?? 0,
    licenseCount: row.license_count ?? 0,
    pendingRequestCount: row.pending_request_count ?? 0,
  };
}

// ใช้ list คอลัมน์แบบระบุชัดเจนแทน `a.*`: ตาราง assets มีคอลัมน์
// manufacturer/model ของตัวเอง (เป็น fallback ที่เก็บไว้สำหรับ peripheral
// asset) ซึ่งถ้าไม่ระบุชัดจะชนชื่อกับ manufacturer/model ฝั่งอ่านที่คำนวณจาก
// COALESCE ด้านล่าง การ join ตาราง agents ใส่ org_id ไว้ทั้งสองฝั่ง — ถ้าไม่ใส่
// asset อาจไป join กับ agent ที่มี hostname ซ้ำกันแต่เป็นของ org อื่น
// (agent_id เพียงอย่างเดียวไม่ unique ข้าม organization ดู comment บนสุดของ
// ไฟล์นี้) การ join ของ vendors/purchase_orders/asset_models ด้านล่างก็ใส่
// เงื่อนไข org_id เดียวกันด้วยเหตุผลเดียวกัน — แม้ vendor_id/purchase_order_id/
// asset_model_id เพียงอย่างเดียวจะ unique ทั่วทั้งระบบอยู่แล้ว (เป็น UUID PK
// จริง ต่างจาก agent_id) จึงไม่จำเป็นต่อความถูกต้องเท่ากับการ join ของ agents
// แต่ยังคงใส่ไว้เป็นเกราะป้องกันซ้อนอีกชั้น: id ที่ผิดหรือข้าม tenant จะ
// render ออกมาเป็น "—" แทนที่จะมีโอกาสรั่วชื่อ vendor/PO/model ของ org อื่น
// ใช้ร่วมกันโดย listAssets และ listAssetsForEmployee เพื่อไม่ให้ทั้งสองฟังก์ชัน
// เพี้ยนไปคนละแบบจากการ project ตารางเดียวกัน — extraWhere/extraParams ให้
// ผู้เรียกจำกัด WHERE clause เพิ่มได้ (parameter เริ่มที่ $2) โดยไม่ต้องเขียน
// query ซ้ำทั้งหมด
async function queryAssets(pool: Pool, orgId: string, extraWhere = "", extraParams: unknown[] = []): Promise<AssetWithLiveInfo[]> {
  const { rows } = await pool.query<AssetRow>(
    `SELECT a.asset_tag, a.agent_id, a.status, a.category, a.location, a.order_number,
            a.checked_out_to, a.checked_out_to_email, a.checked_out_to_department,
            a.checkout_date, a.expected_checkin_date, a.eol_date,
            a.notes, a.manual_serial_number, a.asset_type, a.parent_agent_id,
            a.purchase_cost, a.purchase_date, a.depreciation_years, a.salvage_value, a.warranty_expiry_date,
            a.asset_model_id, a.vendor_id, a.purchase_order_id, a.checked_out_to_employee_id,
            a.custom_field_1, a.custom_field_2, a.custom_field_3, a.custom_field_4, a.custom_field_5, a.is_requestable,
            a.created_at, a.updated_at,
            ag.status AS live_status,
            COALESCE(ag.last_telemetry->>'serial_number', a.manual_serial_number) AS serial_number,
            COALESCE(ag.last_telemetry->>'model', a.model) AS model,
            COALESCE(ag.last_telemetry->>'manufacturer', a.manufacturer) AS manufacturer,
            ag.last_telemetry->'ip_addresses' AS ip_addresses,
            ag.last_telemetry->>'cpu_model' AS cpu_model,
            ag.last_telemetry->'physical_disks' AS physical_disks,
            lc.agent_id AS last_connection_agent_id,
            lc.connected_at AS last_connected_at,
            lc.disconnected_at AS last_connection_disconnected_at,
            v.name AS vendor_name,
            po.po_number AS purchase_order_number,
            am.name AS asset_model_name,
            emp.name AS checked_out_to_employee_name,
            mt.next_date AS next_maintenance_date,
            mt.open_count AS open_maintenance_count,
            COALESCE((SELECT count(*) FROM software_license_assignments sla
                      WHERE sla.org_id = a.org_id AND sla.asset_tag = a.asset_tag), 0)::int AS license_count,
            COALESCE((SELECT count(*) FROM asset_requests ar
                      WHERE ar.org_id = a.org_id AND ar.asset_tag = a.asset_tag AND ar.status = 'pending'), 0)::int AS pending_request_count
     FROM assets a
     LEFT JOIN agents ag ON ag.agent_id = a.agent_id AND ag.org_id = a.org_id
     LEFT JOIN LATERAL (
       SELECT agent_id, connected_at, disconnected_at
       FROM asset_connection_history h
       WHERE h.asset_tag = a.asset_tag AND h.org_id = a.org_id
       ORDER BY connected_at DESC
       LIMIT 1
     ) lc ON true
     LEFT JOIN vendors v ON v.id = a.vendor_id AND v.org_id = a.org_id
     LEFT JOIN purchase_orders po ON po.id = a.purchase_order_id AND po.org_id = a.org_id
     LEFT JOIN asset_models am ON am.id = a.asset_model_id AND am.org_id = a.org_id
     LEFT JOIN employees emp ON emp.id = a.checked_out_to_employee_id AND emp.org_id = a.org_id
     LEFT JOIN LATERAL (
       -- ไม่มี GROUP BY ดังนั้นจะได้แถวเดียวเสมอ (next_date เป็น NULL,
       -- open_count เป็น 0 เมื่อไม่มีรายการนัดหมาย) — open_maintenance_count
       -- จึงไม่มีทางกลับมาเป็น SQL NULL
       SELECT min(scheduled_date) AS next_date, count(*)::int AS open_count
       FROM maintenance_records m
       WHERE m.org_id = a.org_id AND m.asset_tag = a.asset_tag
         AND m.status = 'scheduled' AND m.scheduled_date IS NOT NULL
     ) mt ON true
     WHERE a.org_id = $1 ${extraWhere}
     ORDER BY a.asset_tag ASC`,
    [orgId, ...extraParams],
  );
  return rows.map(rowToAsset);
}

export function listAssets(pool: Pool, orgId: string): Promise<AssetWithLiveInfo[]> {
  return queryAssets(pool, orgId);
}

// ใช้แสดงลิสต์ "กำลังถือครองอยู่" ในหน้ารายละเอียดพนักงาน — ใช้ projection
// เดียวกับ listAssets (ผ่าน queryAssets) แทนที่จะเขียน query บางกว่าแยกต่างหาก
// ซึ่งจะเพี้ยนไปจากกันในภายหลัง การ join เพิ่มไม่มีต้นทุนอะไรเลยเมื่อจำนวนแถว
// ต่อพนักงานมีไม่มาก
export function listAssetsForEmployee(pool: Pool, orgId: string, employeeId: string): Promise<AssetWithLiveInfo[]> {
  return queryAssets(pool, orgId, "AND a.checked_out_to_employee_id = $2", [employeeId]);
}

// ค้นหา asset ตัวเดียวด้วย tag แบบไม่สนตัวพิมพ์เล็กใหญ่ — asset tag เป็น ID
// สั้น ๆ ที่ unique อยู่แล้ว (รูปแบบ OF-0001) จึงจับคู่แบบตรงตัวได้เลย ไม่ต้อง
// ใช้การ resolve ชื่อแบบคลุมเครืออย่างที่ findVendorByName ใน vendorsStore.ts
// ต้องทำสำหรับชื่อ vendor แบบข้อความอิสระ ใช้โดย security/erpGuardrail.ts
// เพื่อ resolve targetName จากคำสั่งที่ AI ออกให้ตรงกับ asset จริง
export async function getAssetByTag(pool: Pool, orgId: string, assetTag: string): Promise<AssetRecord | null> {
  const { rows } = await pool.query<AssetRow>(`SELECT * FROM assets WHERE org_id = $1 AND lower(asset_tag) = lower($2)`, [orgId, assetTag]);
  return rows[0] ? rowToAsset(rows[0]) : null;
}

// อุปกรณ์ที่เคยเชื่อมต่อมาแล้วอย่างน้อยหนึ่งครั้งแต่ยังไม่มี asset record —
// ใช้แสดง prompt "ลงทะเบียนอุปกรณ์นี้อย่างรวดเร็ว" ใน UI แทนที่จะบังคับให้
// พิมพ์ข้อมูล asset ทุกตัวเองตั้งแต่ต้น
export async function listUnregisteredAgents(pool: Pool, orgId: string): Promise<string[]> {
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT ag.agent_id FROM agents ag
     LEFT JOIN assets a ON a.agent_id = ag.agent_id AND a.org_id = ag.org_id
     WHERE ag.org_id = $1 AND a.asset_tag IS NULL
     ORDER BY ag.agent_id ASC`,
    [orgId],
  );
  return rows.map((r) => r.agent_id);
}

// เรียงเลขแยกตาม org — ถ้าใช้ sequence กลางร่วมกันทุก org จะรั่วข้อมูลคร่าว ๆ
// เรื่องจำนวนการสมัคร/ขนาด fleet ข้าม org ให้กับใครก็ตามที่เห็น tag ของ org
// อื่น (ภาพหน้าจอ support, เอกสารที่แชร์กัน) ซึ่งเลขทะเบียนสินค้าคงคลังของ
// ลูกค้าแต่ละรายไม่มีเหตุผลที่จะต้องเปิดเผยข้อมูลนั้น
export async function nextAssetTag(pool: Pool, orgId: string): Promise<string> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE org_id = $1`, [orgId]);
  const n = (rows[0]?.n ?? 0) + 1;
  return `OF-${String(n).padStart(4, "0")}`;
}

export interface AssetInput {
  agentId?: string | null | undefined;
  status?: string | undefined;
  category?: string | null | undefined;
  location?: string | null | undefined;
  orderNumber?: string | null | undefined;
  checkedOutTo?: string | null | undefined;
  checkedOutToEmail?: string | null | undefined;
  checkedOutToDepartment?: string | null | undefined;
  checkoutDate?: string | null | undefined;
  expectedCheckinDate?: string | null | undefined;
  eolDate?: string | null | undefined;
  notes?: string | null | undefined;
  manualSerialNumber?: string | null | undefined;
  assetType?: AssetType | undefined;
  manufacturer?: string | null | undefined;
  model?: string | null | undefined;
  parentAgentId?: string | null | undefined;
  purchaseCost?: number | null | undefined;
  purchaseDate?: string | null | undefined;
  depreciationYears?: number | null | undefined;
  salvageValue?: number | null | undefined;
  warrantyExpiryDate?: string | null | undefined;
  assetModelId?: string | null | undefined;
  vendorId?: string | null | undefined;
  purchaseOrderId?: string | null | undefined;
  checkedOutToEmployeeId?: string | null | undefined;
  customField1?: string | null | undefined;
  customField2?: string | null | undefined;
  customField3?: string | null | undefined;
  customField4?: string | null | undefined;
  customField5?: string | null | undefined;
  isRequestable?: boolean | undefined;
}

export async function createAsset(pool: Pool, orgId: string, assetTag: string, input: AssetInput): Promise<AssetRecord> {
  const { rows } = await pool.query<AssetRow>(
    `INSERT INTO assets
       (org_id, asset_tag, agent_id, status, category, location, order_number, checked_out_to, checked_out_to_email, checked_out_to_department, checkout_date, expected_checkin_date, eol_date, notes, manual_serial_number, asset_type, manufacturer, model, parent_agent_id, purchase_cost, purchase_date, depreciation_years, salvage_value, warranty_expiry_date, asset_model_id, custom_field_1, custom_field_2, custom_field_3, custom_field_4, custom_field_5, is_requestable, vendor_id, purchase_order_id, checked_out_to_employee_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
     RETURNING *`,
    [
      orgId,
      assetTag,
      input.agentId ?? null,
      input.status ?? "ready_to_deploy",
      input.category ?? null,
      input.location ?? null,
      input.orderNumber ?? null,
      input.checkedOutTo ?? null,
      input.checkedOutToEmail ?? null,
      input.checkedOutToDepartment ?? null,
      input.checkoutDate ?? null,
      input.expectedCheckinDate ?? null,
      input.eolDate ?? null,
      input.notes ?? null,
      input.manualSerialNumber ?? null,
      input.assetType ?? "computer",
      input.manufacturer ?? null,
      input.model ?? null,
      input.parentAgentId ?? null,
      input.purchaseCost ?? null,
      input.purchaseDate ?? null,
      input.depreciationYears ?? null,
      input.salvageValue ?? null,
      input.warrantyExpiryDate ?? null,
      input.assetModelId ?? null,
      input.customField1 ?? null,
      input.customField2 ?? null,
      input.customField3 ?? null,
      input.customField4 ?? null,
      input.customField5 ?? null,
      input.isRequestable ?? false,
      input.vendorId ?? null,
      input.purchaseOrderId ?? null,
      input.checkedOutToEmployeeId ?? null,
    ],
  );
  return rowToAsset(rows[0]!);
}

// แตะเฉพาะ field ที่มีอยู่จริงใน `input` เท่านั้น — field ที่เป็น `undefined`
// จะคงค่าเดิมไว้ ส่วนการส่ง "" มาชัดเจนจะเคลียร์เป็น NULL วิธีนี้ต้องสร้าง SET
// clause แบบไดนามิก (ยัง parameterized เต็มรูปแบบ — มีแค่ชื่อคอลัมน์ที่ hardcode
// ไว้ ไม่ใช่ข้อมูลจากผู้ใช้) แทนที่จะใช้ UPDATE แบบตายตัวตัวเดียว เพราะ query
// แบบ COALESCE ตายตัวแยกแยะไม่ได้ระหว่าง "ปล่อยค่านี้ไว้เฉย ๆ" กับ "เคลียร์
// field นี้"
export async function updateAsset(pool: Pool, orgId: string, assetTag: string, input: Partial<AssetInput>): Promise<AssetRecord | null> {
  const columns: Record<string, unknown> = {
    agent_id: input.agentId,
    status: input.status,
    category: input.category,
    location: input.location,
    order_number: input.orderNumber,
    checked_out_to: input.checkedOutTo,
    checked_out_to_email: input.checkedOutToEmail,
    checked_out_to_department: input.checkedOutToDepartment,
    checkout_date: input.checkoutDate,
    expected_checkin_date: input.expectedCheckinDate,
    eol_date: input.eolDate,
    notes: input.notes,
    manual_serial_number: input.manualSerialNumber,
    asset_type: input.assetType,
    manufacturer: input.manufacturer,
    model: input.model,
    parent_agent_id: input.parentAgentId,
    purchase_cost: input.purchaseCost,
    purchase_date: input.purchaseDate,
    depreciation_years: input.depreciationYears,
    salvage_value: input.salvageValue,
    warranty_expiry_date: input.warrantyExpiryDate,
    asset_model_id: input.assetModelId,
    vendor_id: input.vendorId,
    purchase_order_id: input.purchaseOrderId,
    checked_out_to_employee_id: input.checkedOutToEmployeeId,
    custom_field_1: input.customField1,
    custom_field_2: input.customField2,
    custom_field_3: input.customField3,
    custom_field_4: input.customField4,
    custom_field_5: input.customField5,
    is_requestable: input.isRequestable,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [assetTag, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rows } = await pool.query<AssetRow>(
    `UPDATE assets SET ${sets.join(", ")} WHERE asset_tag = $1 AND org_id = $2 RETURNING *`,
    values,
  );
  return rows.length ? rowToAsset(rows[0]!) : null;
}

// ค้นหา asset ที่ลงทะเบียนไว้ล่วงหน้า (สร้างก่อนที่อุปกรณ์จะเชื่อมต่อครั้งแรก)
// ที่ซีเรียลซึ่งกรอกเองตรงกับค่าที่เพิ่งเห็นสดจาก telemetry เพื่อให้ผู้เรียก
// เชื่อมโยงทั้งสองเข้าด้วยกันแทนที่จะสร้างแถวซ้ำ รับเฉพาะตัวเลือกที่ยังไม่มี
// agent_id เท่านั้น — asset ที่เชื่อมโยงกับ agent อื่นอยู่แล้วจะไม่ถูกย้ายไปหา
// agent ใหม่แค่เพราะซีเรียลบังเอิญตรงกัน จำกัดขอบเขตด้วย org: ถ้าไม่ทำแบบนี้
// อุปกรณ์ของ org A อาจไปรวมกับ asset ที่ลงทะเบียนไว้ล่วงหน้าของ org B ที่
// บังเอิญมีซีเรียลตรงกันโดยไม่รู้ตัว
export async function findUnlinkedAssetBySerial(pool: Pool, orgId: string, serial: string): Promise<string | null> {
  const { rows } = await pool.query<{ asset_tag: string }>(
    `SELECT asset_tag FROM assets WHERE org_id = $1 AND agent_id IS NULL AND manual_serial_number = $2 LIMIT 1`,
    [orgId, serial],
  );
  return rows[0]?.asset_tag ?? null;
}

// ค้นหา asset ประเภท "peripheral" (เช่น จอมอนิเตอร์) จากซีเรียลที่กรอกเอง
// ของตัวมันเอง ไม่สนสถานะการเชื่อมโยง — ใช้โดยระบบติดตาม connection-history
// ใน db/persistence.ts เพื่อจดจำ peripheral ที่ปรากฏใน connected_devices
// list ของ agent ตัวใดตัวหนึ่ง ไม่ว่าตอนนี้จะเชื่อมโยงกับ agent เดียวกันนั้น
// อยู่หรือไม่ก็ตาม จำกัดขอบเขตด้วย org ด้วยเหตุผลป้องกันการรวมข้าม org
// เดียวกับ findUnlinkedAssetBySerial ด้านบน
export async function findPeripheralAssetBySerial(
  pool: Pool,
  orgId: string,
  serial: string,
): Promise<{ assetTag: string; parentAgentId: string | null } | null> {
  const { rows } = await pool.query<{ asset_tag: string; parent_agent_id: string | null }>(
    `SELECT asset_tag, parent_agent_id FROM assets WHERE org_id = $1 AND asset_type = 'peripheral' AND manual_serial_number = $2 LIMIT 1`,
    [orgId, serial],
  );
  return rows[0] ? { assetTag: rows[0].asset_tag, parentAgentId: rows[0].parent_agent_id } : null;
}

// ป้อนข้อมูลให้แผง "ต้องดำเนินการ" บน dashboard และงาน daily digest — ครบ
// กำหนดภายใน `withinDays` (รวมที่หมดอายุไปแล้วด้วย) เพื่อให้ทั้งสองจุดใช้
// query รูปแบบเดียวกัน จับคู่แบบเดียวกับ listUpcomingMaintenance ใน
// maintenance/maintenanceStore.ts
export async function listAssetsWithExpiringWarranty(pool: Pool, orgId: string, withinDays: number): Promise<{ assetTag: string; warrantyExpiryDate: string }[]> {
  const { rows } = await pool.query<{ asset_tag: string; warranty_expiry_date: string }>(
    `SELECT asset_tag, warranty_expiry_date FROM assets
     WHERE org_id = $1 AND warranty_expiry_date IS NOT NULL
       AND warranty_expiry_date <= (CURRENT_DATE + $2 * INTERVAL '1 day')
     ORDER BY warranty_expiry_date ASC`,
    [orgId, withinDays],
  );
  return rows.map((r) => ({ assetTag: r.asset_tag, warrantyExpiryDate: r.warranty_expiry_date }));
}

// เช็คอินแบบคลิกเดียว: เคลียร์ field การเบิก (รวมถึง employee FK ด้วย —
// ไม่งั้น asset ที่เช็คอินแล้วจะยังค้างอยู่ในลิสต์ "กำลังถือครองอยู่" ของ
// พนักงานคนนั้น) เปลี่ยนสถานะกลับเป็น ready_to_deploy (เฉพาะตอนที่เดิมเป็น
// 'deployed' เท่านั้น — asset ที่ in_repair หรือ retired จะคงสถานะเดิมไว้
// checkin ไม่ใช่การ override สถานะ) และปิด handover ที่เปิดอยู่ล่าสุด
// (returned_at IS NULL) ของ asset นี้แบบ best-effort เพื่อให้ "ตอนนี้ใครถือ
// อยู่" (จากตาราง handovers) กับตัวแถว asset เองไม่ขัดแย้งกัน เรียกใช้ได้อย่าง
// ปลอดภัยกับ asset ที่ไม่เคยผ่านการ handover แบบเป็นทางการ (ตั้ง
// checked_out_to ด้วยมือผ่านฟอร์ม asset) — ในกรณีนั้น UPDATE ฝั่ง handover
// จะแค่ไม่จับคู่กับแถวไหนเลย
export async function checkinAsset(pool: Pool, orgId: string, assetTag: string): Promise<AssetRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<AssetRow>(
      `UPDATE assets SET
         checked_out_to = NULL, checked_out_to_email = NULL, checked_out_to_department = NULL,
         checked_out_to_employee_id = NULL,
         checkout_date = NULL, expected_checkin_date = NULL,
         status = CASE WHEN status = 'deployed' THEN 'ready_to_deploy' ELSE status END,
         updated_at = now()
       WHERE org_id = $1 AND asset_tag = $2 RETURNING *`,
      [orgId, assetTag],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE handovers SET returned_at = now(), updated_at = now()
       WHERE org_id = $1 AND asset_tag = $2 AND returned_at IS NULL
       AND id = (SELECT id FROM handovers WHERE org_id = $1 AND asset_tag = $2 AND returned_at IS NULL ORDER BY created_at DESC LIMIT 1)`,
      [orgId, assetTag],
    );
    await client.query("COMMIT");
    return rowToAsset(rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAsset(pool: Pool, orgId: string, assetTag: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM assets WHERE asset_tag = $1 AND org_id = $2`, [assetTag, orgId]);
  return (rowCount ?? 0) > 0;
}
