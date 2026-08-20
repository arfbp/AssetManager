// รายชื่อแผนก — เป็นค่ากลางที่แทนที่การพิมพ์ชื่อแผนกแยกกันอิสระบน
// assets.checked_out_to_department กับ handovers.employee_department แบบเดิม
// CRUD ปกติ scope ต่อ org รูปแบบเดียวกับ vendors/vendorsStore.ts
import type { Pool } from "pg";

export interface DepartmentRecord {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  // join สดทุกครั้งที่อ่าน ไม่เคยเก็บไว้ — แนวทาง "คำนวณสด ไม่ cache" เดียวกับ
  // assetCount/handoverCount ของ employeesStore.ts รับประกันว่าเป็นตัวเลขผ่าน
  // COALESCE ไม่มีทาง SQL NULL
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  employee_count: number;
  created_at: string;
  updated_at: string;
}

function rowToDepartment(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    notes: row.notes,
    employeeCount: row.employee_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_WITH_COUNT = `SELECT d.id, d.name, d.code, d.notes, d.created_at, d.updated_at,
       COALESCE((SELECT count(*) FROM employees e WHERE e.org_id = d.org_id AND e.department_id = d.id), 0)::int AS employee_count
     FROM departments d`;

export async function listDepartments(pool: Pool, orgId: string): Promise<DepartmentRecord[]> {
  const { rows } = await pool.query<DepartmentRow>(`${SELECT_WITH_COUNT} WHERE d.org_id = $1 ORDER BY d.name ASC`, [orgId]);
  return rows.map(rowToDepartment);
}

export async function getDepartment(pool: Pool, orgId: string, departmentId: string): Promise<DepartmentRecord | null> {
  const { rows } = await pool.query<DepartmentRow>(`${SELECT_WITH_COUNT} WHERE d.org_id = $1 AND d.id = $2`, [orgId, departmentId]);
  return rows[0] ? rowToDepartment(rows[0]) : null;
}

export interface DepartmentInput {
  name?: string | undefined;
  code?: string | null | undefined;
  notes?: string | null | undefined;
}

export async function createDepartment(pool: Pool, orgId: string, input: DepartmentInput): Promise<DepartmentRecord> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO departments (org_id, name, code, notes) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, input.name ?? "", input.code ?? null, input.notes ?? null],
  );
  return (await getDepartment(pool, orgId, rows[0]!.id))!;
}

// ใช้ convention dynamic-SET-clause / ""->NULL แบบเดียวกับ updateVendor ของ
// vendorsStore.ts — แก้เฉพาะฟิลด์ที่มีอยู่ใน `input` เท่านั้น
export async function updateDepartment(pool: Pool, orgId: string, departmentId: string, input: DepartmentInput): Promise<DepartmentRecord | null> {
  const columns: Record<string, unknown> = {
    name: input.name,
    code: input.code,
    notes: input.notes,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [departmentId, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rowCount } = await pool.query(`UPDATE departments SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`, values);
  if (!rowCount) return null;
  return getDepartment(pool, orgId, departmentId);
}

export async function deleteDepartment(pool: Pool, orgId: string, departmentId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM departments WHERE id = $1 AND org_id = $2`, [departmentId, orgId]);
  return (rowCount ?? 0) > 0;
}

// จับคู่แบบ exact ก่อนแล้วค่อย substring (ไม่สนตัวพิมพ์เล็กใหญ่) — รูปแบบการ
// resolve เดียวกับ findVendorByName ของ vendorsStore.ts
export async function findDepartmentByName(pool: Pool, orgId: string, name: string): Promise<DepartmentRecord | "none" | "ambiguous"> {
  const { rows: exact } = await pool.query<DepartmentRow>(`${SELECT_WITH_COUNT} WHERE d.org_id = $1 AND lower(d.name) = lower($2)`, [orgId, name]);
  if (exact.length === 1) return rowToDepartment(exact[0]!);
  if (exact.length > 1) return "ambiguous";

  const { rows: partial } = await pool.query<DepartmentRow>(`${SELECT_WITH_COUNT} WHERE d.org_id = $1 AND lower(d.name) LIKE lower($2)`, [orgId, `%${name}%`]);
  if (partial.length === 1) return rowToDepartment(partial[0]!);
  if (partial.length > 1) return "ambiguous";
  return "none";
}
