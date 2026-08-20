// การเบิก asset (handover) — บันทึกการครอบครองที่พิมพ์ออกมาได้เมื่อมอบ asset
// ให้พนักงาน การสร้าง record นี้จะเขียนข้อมูลพนักงานตัวเดียวกันลงไปที่ฟิลด์
// checked_out_to*/checkout_date ของ asset เอง (ฟิลด์ของ Track D บน
// assets/assetsStore.ts) เพื่อให้หน้าจอ "checked out to" ของ Asset Registry
// กับประวัติ handover ของโมดูลนี้ sync กันจากการกระทำครั้งเดียว ไม่ต้องให้
// ผู้ใช้กรอกข้อมูลเดิมสองรอบ
import type { Pool } from "pg";

export type HandoverStatus = "pending_signature" | "acknowledged";

export interface HandoverRecord {
  id: string;
  assetTag: string;
  // ลิงก์แบบมีโครงสร้างไปยัง employee directory (migrations/0030) เป็น null
  // สำหรับ handover ที่สร้างก่อนมี directory หรือกรณีผู้ใช้ตั้งใจพิมพ์ชื่อที่
  // ไม่มีใน directory — ไม่ว่ากรณีไหน employeeName ด้านล่างคือ snapshot
  // ณ เวลานั้นที่ถือเป็นข้อมูลจริงเสมอ
  employeeId: string | null;
  employeeName: string;
  employeeEmail: string | null;
  employeeDepartment: string | null;
  handoverDate: string;
  conditionNotes: string | null;
  status: HandoverStatus;
  issuedBy: string;
  // NULL หมายถึงยังไม่คืน — ปุ่ม check-in คลิกเดียว (checkinAsset ของ
  // assets/assetsStore.ts) จะตั้งค่านี้บน handover ที่ยังเปิดอยู่ล่าสุดของ asset
  returnedAt: string | null;
  // หลักฐานลงนามบนหน้าจอ (ไม่บังคับ) ผูกไปกับ transition pending_signature ->
  // acknowledged ที่มีอยู่แล้ว — เป็น null ทั้งคู่หมายถึงองค์กรไม่ได้ตั้งค่า EULA
  // สำหรับการเบิก หรือ handover นี้ถูก acknowledge ก่อนที่ฟีเจอร์นี้จะมี ทั้งสองกรณี
  // flow พิมพ์กระดาษแล้วเซ็นจริงยังใช้งานได้ปกติ
  employeeSignature: string | null;
  eulaAcceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface HandoverRow {
  id: string;
  asset_tag: string;
  employee_id: string | null;
  employee_name: string;
  employee_email: string | null;
  employee_department: string | null;
  handover_date: string;
  condition_notes: string | null;
  status: HandoverStatus;
  issued_by: string;
  returned_at: string | null;
  employee_signature: string | null;
  eula_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: HandoverRow): HandoverRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeEmail: row.employee_email,
    employeeDepartment: row.employee_department,
    handoverDate: row.handover_date,
    conditionNotes: row.condition_notes,
    status: row.status,
    issuedBy: row.issued_by,
    returnedAt: row.returned_at,
    employeeSignature: row.employee_signature,
    eulaAcceptedAt: row.eula_accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, employee_id, employee_name, employee_email, employee_department, handover_date, condition_notes, status, issued_by, returned_at, employee_signature, eula_accepted_at, created_at, updated_at`;

export async function listHandovers(pool: Pool, orgId: string): Promise<HandoverRecord[]> {
  const { rows } = await pool.query<HandoverRow>(`SELECT ${SELECT_COLUMNS} FROM handovers WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(rowToRecord);
}

export async function getHandover(pool: Pool, orgId: string, id: string): Promise<HandoverRecord | null> {
  const { rows } = await pool.query<HandoverRow>(`SELECT ${SELECT_COLUMNS} FROM handovers WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface HandoverInput {
  assetTag: string;
  // ถูก resolve ไว้แล้วโดย route handler (POST /handovers) ก่อนจะมาถึง store นี้
  // store จึงไม่ต้องรู้อะไรเลย employeeName คือ string ที่ใช้แสดงผลจริงสุดท้าย
  // เสมอ ไม่ว่าจะมาจากการเลือกใน directory หรือพิมพ์เอง
  employeeId?: string | null | undefined;
  employeeName: string;
  employeeEmail?: string | null | undefined;
  employeeDepartment?: string | null | undefined;
  handoverDate?: string | undefined;
  conditionNotes?: string | null | undefined;
}

// เขียน row ของ handover กับฟิลด์ checked_out_to* ของ asset (รวม employee FK
// ด้วยแล้ว) พร้อมกัน — จะสำเร็จทั้งคู่หรือไม่สำเร็จเลย เพื่อไม่ให้ข้อมูลสองฝั่ง
// ขัดแย้งกันเรื่องว่าใครถืออยู่
export async function createHandover(pool: Pool, orgId: string, issuedBy: string, input: HandoverInput): Promise<HandoverRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const handoverDate = input.handoverDate ?? new Date().toISOString().slice(0, 10);
    const employeeId = input.employeeId ?? null;
    const { rows } = await client.query<HandoverRow>(
      `INSERT INTO handovers (org_id, asset_tag, employee_id, employee_name, employee_email, employee_department, handover_date, condition_notes, status, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_signature', $9)
       RETURNING ${SELECT_COLUMNS}`,
      [orgId, input.assetTag, employeeId, input.employeeName, input.employeeEmail ?? null, input.employeeDepartment ?? null, handoverDate, input.conditionNotes ?? null, issuedBy],
    );
    await client.query(
      `UPDATE assets SET checked_out_to = $3, checked_out_to_email = $4, checked_out_to_department = $5, checked_out_to_employee_id = $6, checkout_date = $7, updated_at = now()
       WHERE org_id = $1 AND asset_tag = $2`,
      [orgId, input.assetTag, input.employeeName, input.employeeEmail ?? null, input.employeeDepartment ?? null, employeeId, handoverDate],
    );
    await client.query("COMMIT");
    return rowToRecord(rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function acknowledgeHandover(
  pool: Pool,
  orgId: string,
  id: string,
  proof?: { employeeSignature?: string | null | undefined; eulaAccepted?: boolean | undefined },
): Promise<HandoverRecord | null> {
  const { rows } = await pool.query<HandoverRow>(
    `UPDATE handovers SET status = 'acknowledged', updated_at = now(),
       employee_signature = COALESCE($3, employee_signature),
       eula_accepted_at = CASE WHEN $4 THEN now() ELSE eula_accepted_at END
     WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`,
    [id, orgId, proof?.employeeSignature ?? null, proof?.eulaAccepted ?? false],
  );
  return rows.length ? rowToRecord(rows[0]!) : null;
}
