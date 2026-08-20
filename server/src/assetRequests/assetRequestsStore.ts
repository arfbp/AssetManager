// คำขอ asset แบบ self-service — พนักงาน (role ที่ authenticated แล้วทุกแบบ
// รวมถึง viewer) ขอ asset ที่เปิดให้ขอได้ แล้ว admin เป็นคนอนุมัติหรือปฏิเสธ
// ใช้รูปแบบตาราง transition สถานะแบบเดียวกับ ALLOWED_TRANSITIONS ของ
// procurement/purchaseOrdersStore.ts เพียงแต่ไม่มีสถานะ "draft" เพราะ
// ไม่มีฟอร์มหลายรายการที่ต้องบันทึกไว้ทำต่อ ส่วนขั้นตอนเบิกจริง (แก้ asset +
// สร้าง handover) จะทำใน route handler ตอน approve ไม่ใช่ที่นี่ — ใช้หลักการ
// เดียวกับ "cross-table orchestration อยู่ที่ routes.ts" แบบ PO receive handler
import type { Pool } from "pg";

export interface AssetRequestRecord {
  id: string;
  assetTag: string;
  requestedBy: string;
  note: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  // ตั้งค่าตอน admin อนุมัติ (migrations/0030) — แยกจาก requestedBy ซึ่งเก็บ
  // username ที่ login เข้า OptiFleet ของคนที่กด "Request" ไว้ตลอด (audit trail
  // ว่า "ใครเป็นคนขอ") ส่วนฟิลด์นี้คือ "ใครเป็นคนรับจริง" ดู
  // routes.ts's POST /asset-requests/:id/approve
  onBehalfOfEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RequestRow {
  id: string;
  asset_tag: string;
  requested_by: string;
  note: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  on_behalf_of_employee_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRequest(row: RequestRow): AssetRequestRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    requestedBy: row.requested_by,
    note: row.note,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    onBehalfOfEmployeeId: row.on_behalf_of_employee_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, requested_by, note, status, approved_by, approved_at, on_behalf_of_employee_id, created_at, updated_at`;

export async function listAssetRequests(pool: Pool, orgId: string): Promise<AssetRequestRecord[]> {
  const { rows } = await pool.query<RequestRow>(`SELECT ${SELECT_COLUMNS} FROM asset_requests WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(rowToRequest);
}

export async function getAssetRequest(pool: Pool, orgId: string, id: string): Promise<AssetRequestRecord | null> {
  const { rows } = await pool.query<RequestRow>(`SELECT ${SELECT_COLUMNS} FROM asset_requests WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return rows[0] ? rowToRequest(rows[0]) : null;
}

export async function createAssetRequest(pool: Pool, orgId: string, requestedBy: string, assetTag: string, note: string | null): Promise<AssetRequestRecord> {
  const { rows } = await pool.query<RequestRow>(
    `INSERT INTO asset_requests (org_id, asset_tag, requested_by, note, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING ${SELECT_COLUMNS}`,
    [orgId, assetTag, requestedBy, note],
  );
  return rowToRequest(rows[0]!);
}

export class InvalidAssetRequestTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`can't move an asset request from "${from}" to "${to}"`);
    this.name = "InvalidAssetRequestTransitionError";
  }
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ["approved", "rejected", "cancelled"],
};

export async function setAssetRequestStatus(
  pool: Pool,
  orgId: string,
  id: string,
  toStatus: "approved" | "rejected" | "cancelled",
  approvedBy?: string,
): Promise<AssetRequestRecord | null> {
  const current = await getAssetRequest(pool, orgId, id);
  if (!current) return null;
  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(toStatus)) throw new InvalidAssetRequestTransitionError(current.status, toStatus);

  if (toStatus === "approved" || toStatus === "rejected") {
    await pool.query(`UPDATE asset_requests SET status = $3, approved_by = $4, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
      toStatus,
      approvedBy ?? null,
    ]);
  } else {
    await pool.query(`UPDATE asset_requests SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, toStatus]);
  }
  return getAssetRequest(pool, orgId, id);
}

export async function deleteAssetRequest(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM asset_requests WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}

// ตั้งค่าโดยผู้อนุมัติตอนอนุมัติ — ดู route handler ของ approve ใน routes.ts
// ว่าทำไมถึงแยกจาก requestedBy (เป็น login username ไม่ใช่พนักงานใน directory)
// แยกเป็นฟังก์ชันเล็ก ๆ ของตัวเองแทนที่จะเป็น param ตัวที่ 6 ของ
// setAssetRequestStatus ด้านบน
export async function assignAssetRequestEmployee(pool: Pool, orgId: string, id: string, employeeId: string | null): Promise<void> {
  await pool.query(`UPDATE asset_requests SET on_behalf_of_employee_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, employeeId]);
}
