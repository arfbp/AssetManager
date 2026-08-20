// การโอนย้าย asset แบบเป็นทางการ — บันทึกแยกเป็น record ของตัวเอง ไม่ใช่แบบ
// เดียวกับการเบิกให้บุคคล (handovers/handoversStore.ts) เขียน log และอัปเดต
// location/category ของ asset ในทรานแซกชันเดียวกัน รูปแบบ "log + แก้ข้อมูล
// พร้อมกัน" เดียวกับ createHandover
import type { Pool } from "pg";

export interface AssetTransferRecord {
  id: string;
  assetTag: string;
  fromLocation: string | null;
  toLocation: string | null;
  fromDepartment: string | null;
  toDepartment: string | null;
  transferDate: string;
  reason: string | null;
  transferredBy: string;
  createdAt: string;
}

interface TransferRow {
  id: string;
  asset_tag: string;
  from_location: string | null;
  to_location: string | null;
  from_department: string | null;
  to_department: string | null;
  transfer_date: string;
  reason: string | null;
  transferred_by: string;
  created_at: string;
}

function rowToTransfer(row: TransferRow): AssetTransferRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    fromLocation: row.from_location,
    toLocation: row.to_location,
    fromDepartment: row.from_department,
    toDepartment: row.to_department,
    transferDate: row.transfer_date,
    reason: row.reason,
    transferredBy: row.transferred_by,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, from_location, to_location, from_department, to_department, transfer_date, reason, transferred_by, created_at`;

export async function listAssetTransfers(pool: Pool, orgId: string, assetTag?: string): Promise<AssetTransferRecord[]> {
  const { rows } = assetTag
    ? await pool.query<TransferRow>(`SELECT ${SELECT_COLUMNS} FROM asset_transfers WHERE org_id = $1 AND asset_tag = $2 ORDER BY created_at DESC`, [orgId, assetTag])
    : await pool.query<TransferRow>(`SELECT ${SELECT_COLUMNS} FROM asset_transfers WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(rowToTransfer);
}

export interface AssetTransferInput {
  assetTag: string;
  toLocation?: string | null | undefined;
  fromDepartment?: string | null | undefined;
  toDepartment?: string | null | undefined;
  transferDate?: string | undefined;
  reason?: string | null | undefined;
}

// fromLocation ดึงมาจาก location ปัจจุบันของ asset เสมอ (ไม่ให้ผู้เรียกระบุเอง)
// เพราะจุดประสงค์ของ transfer record คือบันทึกก่อน/หลังที่เป็นจริง ไม่ปล่อยให้
// สองค่านี้เพี้ยนไปจากที่บันทึกอยู่ใน asset จริง ส่วน department ไม่มีฟิลด์
// เทียบเท่าเก็บอยู่ใน assets (เป็นคุณสมบัติของการโอนย้าย ไม่ใช่ของ asset เอง
// เพราะ asset ไม่มี "แผนกประจำ") ดังนั้นทั้งสองฝั่งจึงใช้ค่าที่ผู้เรียกส่งมาตรง ๆ
export async function createAssetTransfer(pool: Pool, orgId: string, transferredBy: string, input: AssetTransferInput): Promise<AssetTransferRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: assetRows } = await client.query<{ location: string | null }>(`SELECT location FROM assets WHERE org_id = $1 AND asset_tag = $2`, [orgId, input.assetTag]);
    const fromLocation = assetRows[0]?.location ?? null;
    const transferDate = input.transferDate ?? new Date().toISOString().slice(0, 10);
    const { rows } = await client.query<TransferRow>(
      `INSERT INTO asset_transfers (org_id, asset_tag, from_location, to_location, from_department, to_department, transfer_date, reason, transferred_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SELECT_COLUMNS}`,
      [orgId, input.assetTag, fromLocation, input.toLocation ?? null, input.fromDepartment ?? null, input.toDepartment ?? null, transferDate, input.reason ?? null, transferredBy],
    );
    if (input.toLocation !== undefined) {
      await client.query(`UPDATE assets SET location = $3, updated_at = now() WHERE org_id = $1 AND asset_tag = $2`, [orgId, input.assetTag, input.toLocation || null]);
    }
    await client.query("COMMIT");
    return rowToTransfer(rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
