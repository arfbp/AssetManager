// log ของงานบำรุงรักษา/ซ่อม/ตรวจสอบ หนึ่งแถวต่อหนึ่งเหตุการณ์ — รูปแบบ "log
// เหตุการณ์ ไม่ใช่สถานะปัจจุบัน" เดียวกับ assets/connectionHistoryStore.ts
// "Overdue" ไม่เคยถูกเก็บไว้ จะคำนวณสดทุกครั้งที่อ่าน record
// (status='scheduled' AND scheduled_date < วันนี้)
import type { Pool } from "pg";

export type MaintenanceType = "scheduled" | "repair" | "inspection";
export type MaintenanceStatus = "scheduled" | "completed" | "cancelled";

export interface MaintenanceRecord {
  id: string;
  assetTag: string;
  type: MaintenanceType;
  description: string;
  scheduledDate: string | null;
  completedDate: string | null;
  status: MaintenanceStatus;
  cost: number | null;
  performedBy: string | null;
  notes: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MaintenanceRow {
  id: string;
  asset_tag: string;
  type: MaintenanceType;
  description: string;
  scheduled_date: string | null;
  completed_date: string | null;
  status: MaintenanceStatus;
  cost: string | null;
  performed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function isOverdue(row: MaintenanceRow): boolean {
  if (row.status !== "scheduled" || !row.scheduled_date) return false;
  return new Date(row.scheduled_date).getTime() < Date.now();
}

function rowToRecord(row: MaintenanceRow): MaintenanceRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    type: row.type,
    description: row.description,
    scheduledDate: row.scheduled_date,
    completedDate: row.completed_date,
    status: row.status,
    cost: row.cost === null ? null : Number(row.cost),
    performedBy: row.performed_by,
    notes: row.notes,
    overdue: isOverdue(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, type, description, scheduled_date, completed_date, status, cost, performed_by, notes, created_at, updated_at`;

export async function listMaintenanceRecords(pool: Pool, orgId: string, assetTag?: string): Promise<MaintenanceRecord[]> {
  const { rows } = assetTag
    ? await pool.query<MaintenanceRow>(
        `SELECT ${SELECT_COLUMNS} FROM maintenance_records WHERE org_id = $1 AND asset_tag = $2 ORDER BY scheduled_date DESC NULLS LAST, created_at DESC`,
        [orgId, assetTag],
      )
    : await pool.query<MaintenanceRow>(`SELECT ${SELECT_COLUMNS} FROM maintenance_records WHERE org_id = $1 ORDER BY scheduled_date DESC NULLS LAST, created_at DESC`, [orgId]);
  return rows.map(rowToRecord);
}

// ป้อนข้อมูลให้แผง "needs attention" บน dashboard และงาน daily digest —
// ครอบคลุมงานที่ครบกำหนดภายใน `withinDays` (รวมที่เลยกำหนดไปแล้วด้วย)
// เพื่อให้สองส่วนนี้ใช้ query รูปแบบเดียวกัน
export async function listUpcomingMaintenance(pool: Pool, orgId: string, withinDays: number): Promise<MaintenanceRecord[]> {
  const { rows } = await pool.query<MaintenanceRow>(
    `SELECT ${SELECT_COLUMNS} FROM maintenance_records
     WHERE org_id = $1 AND status = 'scheduled' AND scheduled_date IS NOT NULL
       AND scheduled_date <= (CURRENT_DATE + $2 * INTERVAL '1 day')
     ORDER BY scheduled_date ASC`,
    [orgId, withinDays],
  );
  return rows.map(rowToRecord);
}

export interface MaintenanceInput {
  assetTag?: string | undefined;
  type?: MaintenanceType | undefined;
  description?: string | undefined;
  scheduledDate?: string | null | undefined;
  completedDate?: string | null | undefined;
  status?: MaintenanceStatus | undefined;
  cost?: number | null | undefined;
  performedBy?: string | null | undefined;
  notes?: string | null | undefined;
}

export async function createMaintenanceRecord(pool: Pool, orgId: string, input: MaintenanceInput): Promise<MaintenanceRecord> {
  const { rows } = await pool.query<MaintenanceRow>(
    `INSERT INTO maintenance_records (org_id, asset_tag, type, description, scheduled_date, completed_date, status, cost, performed_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT_COLUMNS}`,
    [
      orgId,
      input.assetTag ?? "",
      input.type ?? "scheduled",
      input.description ?? "",
      input.scheduledDate ?? null,
      input.completedDate ?? null,
      input.status ?? "scheduled",
      input.cost ?? null,
      input.performedBy ?? null,
      input.notes ?? null,
    ],
  );
  return rowToRecord(rows[0]!);
}

// ใช้ convention dynamic-SET-clause / ""->NULL แบบเดียวกับ updateAsset ของ
// assetsStore.ts
export async function updateMaintenanceRecord(pool: Pool, orgId: string, id: string, input: MaintenanceInput): Promise<MaintenanceRecord | null> {
  const columns: Record<string, unknown> = {
    type: input.type,
    description: input.description,
    scheduled_date: input.scheduledDate,
    completed_date: input.completedDate,
    status: input.status,
    cost: input.cost,
    performed_by: input.performedBy,
    notes: input.notes,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rows } = await pool.query<MaintenanceRow>(`UPDATE maintenance_records SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`, values);
  return rows.length ? rowToRecord(rows[0]!) : null;
}

// ทำเครื่องหมายเสร็จในการเรียกเดียว แทนที่จะให้ทุกที่ต้องเรียก
// updateMaintenanceRecord แล้วตั้งค่าสามฟิลด์แยกกันเอง
export async function completeMaintenanceRecord(pool: Pool, orgId: string, id: string, completedDate: string, cost: number | null): Promise<MaintenanceRecord | null> {
  const { rows } = await pool.query<MaintenanceRow>(
    `UPDATE maintenance_records SET status = 'completed', completed_date = $3, cost = COALESCE($4, cost), updated_at = now()
     WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`,
    [id, orgId, completedDate, cost],
  );
  return rows.length ? rowToRecord(rows[0]!) : null;
}

export async function deleteMaintenanceRecord(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM maintenance_records WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}
