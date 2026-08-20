// ทะเบียนพนักงาน — เป็น record แบบ HR-lite ที่ส่วนอื่น ๆ (การเบิก asset,
// handover, คำขอแบบ self-service) สามารถอ้างอิงได้แทนที่จะใช้ชื่อ free-text
// เฉย ๆ CRUD ปกติ scope ต่อ org รูปแบบเดียวกับ vendors/vendorsStore.ts
// พร้อม join department/user เข้ามาเพื่อแสดงผล
import type { Pool } from "pg";

export type EmployeeStatus = "active" | "inactive";

export interface EmployeeRecord {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  // join สดทุกครั้งที่อ่าน ไม่เคยเก็บไว้ — แนวทาง "คำนวณสด ไม่ cache" เดียวกับ
  // AssetErpSummary.vendorName ของ assetsStore.ts เป็น null เมื่อยังไม่ได้กำหนดแผนก
  departmentName: string | null;
  userId: string | null;
  // join จาก users มาเพื่อแสดงผลอย่างเดียว เป็น null เมื่อ userId เป็น null
  // หรือบัญชีที่ผูกไว้ถูกลบไปแล้ว
  username: string | null;
  status: EmployeeStatus;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  // รับประกันว่าเป็นตัวเลข ไม่มีทาง null — ใช้แสดงในเซลล์ตารางโดยตรงไม่ต้องเช็ค
  assetCount: number;
  handoverCount: number;
  createdAt: string;
  updatedAt: string;
}

interface EmployeeRow {
  id: string;
  employee_code: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_id: string | null;
  department_name: string | null;
  user_id: string | null;
  username: string | null;
  status: EmployeeStatus;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  asset_count: number;
  handover_count: number;
  created_at: string;
  updated_at: string;
}

function rowToEmployee(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    userId: row.user_id,
    username: row.username,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    notes: row.notes,
    assetCount: row.asset_count ?? 0,
    handoverCount: row.handover_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// เงื่อนไข org_id บนทั้งสอง join เป็น defense-in-depth แบบเดียวกับที่บันทึกไว้
// บน join ของ vendor/PO/model ใน listAssets ของ assetsStore.ts — id ที่ join
// เป็น UUID ที่ unique ทั่วระบบอยู่แล้ว การเช็ค org_id นี้แค่ป้องกันไม่ให้ id
// ที่ผิดพลาด resolve ไปโดน row ขององค์กรอื่นเข้า
const SELECT_JOINED = `SELECT e.id, e.employee_code, e.name, e.email, e.phone, e.job_title,
       e.department_id, d.name AS department_name,
       e.user_id, u.username, e.status, e.start_date, e.end_date, e.notes,
       e.created_at, e.updated_at,
       COALESCE((SELECT count(*) FROM assets a
                 WHERE a.org_id = e.org_id AND a.checked_out_to_employee_id = e.id), 0)::int AS asset_count,
       COALESCE((SELECT count(*) FROM handovers h
                 WHERE h.org_id = e.org_id AND h.employee_id = e.id), 0)::int AS handover_count
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id AND d.org_id = e.org_id
     LEFT JOIN users u ON u.id = e.user_id AND u.org_id = e.org_id`;

// คืนค่าทุกสถานะ — ผู้เรียก/ตัวเลือกจะกรองเอา 'active' เองถ้าต้องการ
// (หน้ารายชื่อพนักงานเองก็ต้องใช้ inactive ด้วยเพื่อโชว์ว่าใครลาออกไปแล้ว)
export async function listEmployees(pool: Pool, orgId: string): Promise<EmployeeRecord[]> {
  const { rows } = await pool.query<EmployeeRow>(`${SELECT_JOINED} WHERE e.org_id = $1 ORDER BY e.name ASC`, [orgId]);
  return rows.map(rowToEmployee);
}

export async function getEmployee(pool: Pool, orgId: string, employeeId: string): Promise<EmployeeRecord | null> {
  const { rows } = await pool.query<EmployeeRow>(`${SELECT_JOINED} WHERE e.org_id = $1 AND e.id = $2`, [orgId, employeeId]);
  return rows[0] ? rowToEmployee(rows[0]) : null;
}

// ใช้ตัดสินใจว่าตอน import CSV จะ create หรือ update — บทบาทเดียวกับ assetTag
// ใน loop import ของ assetsStore.ts เพราะ employee_code เป็นฟิลด์เดียวที่
// spreadsheet HR ของผู้ใช้งานน่าจะมีอยู่แล้วเป็น key ประจำตัวที่นิ่ง (ต่างจากชื่อ
// ที่ไม่ unique)
export async function getEmployeeByCode(pool: Pool, orgId: string, employeeCode: string): Promise<EmployeeRecord | null> {
  const { rows } = await pool.query<EmployeeRow>(`${SELECT_JOINED} WHERE e.org_id = $1 AND e.employee_code = $2`, [orgId, employeeCode]);
  return rows[0] ? rowToEmployee(rows[0]) : null;
}

export interface EmployeeInput {
  employeeCode?: string | null | undefined;
  name?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  jobTitle?: string | null | undefined;
  departmentId?: string | null | undefined;
  userId?: string | null | undefined;
  status?: EmployeeStatus | undefined;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  notes?: string | null | undefined;
}

export async function createEmployee(pool: Pool, orgId: string, input: EmployeeInput): Promise<EmployeeRecord> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO employees (org_id, employee_code, name, email, phone, job_title, department_id, user_id, status, start_date, end_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      orgId,
      input.employeeCode ?? null,
      input.name ?? "",
      input.email ?? null,
      input.phone ?? null,
      input.jobTitle ?? null,
      input.departmentId ?? null,
      input.userId ?? null,
      input.status ?? "active",
      input.startDate ?? null,
      input.endDate ?? null,
      input.notes ?? null,
    ],
  );
  return (await getEmployee(pool, orgId, rows[0]!.id))!;
}

// ใช้ convention dynamic-SET-clause / ""->NULL แบบเดียวกับ updateAsset ของ
// assetsStore.ts หลังอัปเดตแล้วรัน joined SELECT ใหม่แทนการใช้ RETURNING *
// เพราะ department_name/username/ตัวนับสองตัวไม่มีทางได้มาจาก RETURNING
// ธรรมดาบนตารางนี้
export async function updateEmployee(pool: Pool, orgId: string, employeeId: string, input: EmployeeInput): Promise<EmployeeRecord | null> {
  const columns: Record<string, unknown> = {
    employee_code: input.employeeCode,
    name: input.name,
    email: input.email,
    phone: input.phone,
    job_title: input.jobTitle,
    department_id: input.departmentId,
    user_id: input.userId,
    status: input.status,
    start_date: input.startDate,
    end_date: input.endDate,
    notes: input.notes,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [employeeId, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rowCount } = await pool.query(`UPDATE employees SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`, values);
  if (!rowCount) return null;
  return getEmployee(pool, orgId, employeeId);
}

export async function deleteEmployee(pool: Pool, orgId: string, employeeId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM employees WHERE id = $1 AND org_id = $2`, [employeeId, orgId]);
  return (rowCount ?? 0) > 0;
}

// จับคู่แบบ exact ก่อนแล้วค่อย substring (ไม่สนตัวพิมพ์เล็กใหญ่) — รูปแบบเดียวกับ
// findVendorByName ของ vendorsStore.ts แต่จำกัดเฉพาะพนักงานที่ active เท่านั้น:
// การ resolve การเบิกผ่าน AI console (หรือการค้นหาด้วยชื่อแบบอื่นใด) ไปโดน
// คนที่ลาออกไปแล้วเป็นคำตอบที่ผิดโดยสิ้นเชิง
export async function findEmployeeByName(pool: Pool, orgId: string, name: string): Promise<EmployeeRecord | "none" | "ambiguous"> {
  const { rows: exact } = await pool.query<EmployeeRow>(
    `${SELECT_JOINED} WHERE e.org_id = $1 AND e.status = 'active' AND lower(e.name) = lower($2)`,
    [orgId, name],
  );
  if (exact.length === 1) return rowToEmployee(exact[0]!);
  if (exact.length > 1) return "ambiguous";

  const { rows: partial } = await pool.query<EmployeeRow>(
    `${SELECT_JOINED} WHERE e.org_id = $1 AND e.status = 'active' AND lower(e.name) LIKE lower($2)`,
    [orgId, `%${name}%`],
  );
  if (partial.length === 1) return rowToEmployee(partial[0]!);
  if (partial.length > 1) return "ambiguous";
  return "none";
}

// ใช้ prefill ของ modal อนุมัติคำขอ asset: "คำขอนี้ถูกส่งมาจาก login ที่เป็น
// ของพนักงาน X ให้แนะนำคนนี้"
export async function findEmployeeByUsername(pool: Pool, orgId: string, username: string): Promise<EmployeeRecord | null> {
  const { rows } = await pool.query<EmployeeRow>(`${SELECT_JOINED} WHERE e.org_id = $1 AND u.username = $2`, [orgId, username]);
  return rows[0] ? rowToEmployee(rows[0]) : null;
}
