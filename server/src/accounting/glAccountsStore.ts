// ผังบัญชี (chart of accounts) — CRUD ปกติแบบ scope ต่อ org รูปแบบเดียวกับ
// vendors/vendorsStore.ts เพิ่มเติมคือ ensureDefaultAccounts ที่ seed บัญชี
// มาตรฐาน 7 ตัวแบบ idempotent ให้ทันทีที่ต้องใช้โพสต์ fixed asset (acquisition,
// depreciation, disposal, adjustment) องค์กรจึงไม่ต้องมาสร้างผังบัญชีเองก่อนใช้งาน
import type { Pool } from "pg";

export type GlAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface GlAccountRecord {
  id: string;
  code: string;
  name: string;
  type: GlAccountType;
  isContra: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GlAccountRow {
  id: string;
  code: string;
  name: string;
  type: GlAccountType;
  is_contra: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

function rowToAccount(row: GlAccountRow): GlAccountRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    isContra: row.is_contra,
    isSystem: row.is_system,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, code, name, type, is_contra, is_system, created_at, updated_at`;

export async function listGlAccounts(pool: Pool, orgId: string): Promise<GlAccountRecord[]> {
  const { rows } = await pool.query<GlAccountRow>(`SELECT ${SELECT_COLUMNS} FROM gl_accounts WHERE org_id = $1 ORDER BY code ASC`, [orgId]);
  return rows.map(rowToAccount);
}

export async function getGlAccount(pool: Pool, orgId: string, id: string): Promise<GlAccountRecord | null> {
  const { rows } = await pool.query<GlAccountRow>(`SELECT ${SELECT_COLUMNS} FROM gl_accounts WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

// จับคู่ code แบบ exact match (ไม่สนตัวพิมพ์เล็กใหญ่) — ใช้ resolve รหัสบัญชี
// มาตรฐานที่ ensureDefaultAccounts/ฟังก์ชันโพสต์ต่าง ๆ ต้องใช้ (เช่น "1500")
// โดยไม่ต้อง hardcode id ไว้ที่ไหนเลย
export async function getGlAccountByCode(pool: Pool, orgId: string, code: string): Promise<GlAccountRecord | null> {
  const { rows } = await pool.query<GlAccountRow>(`SELECT ${SELECT_COLUMNS} FROM gl_accounts WHERE org_id = $1 AND code = $2`, [orgId, code]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export interface GlAccountInput {
  code?: string | undefined;
  name?: string | undefined;
  type?: GlAccountType | undefined;
  isContra?: boolean | undefined;
}

export async function createGlAccount(pool: Pool, orgId: string, input: GlAccountInput, isSystem = false): Promise<GlAccountRecord> {
  const { rows } = await pool.query<GlAccountRow>(
    `INSERT INTO gl_accounts (org_id, code, name, type, is_contra, is_system)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [orgId, input.code ?? "", input.name ?? "", input.type ?? "asset", input.isContra ?? false, isSystem],
  );
  return rowToAccount(rows[0]!);
}

export async function updateGlAccount(pool: Pool, orgId: string, id: string, input: GlAccountInput): Promise<GlAccountRecord | null> {
  const columns: Record<string, unknown> = { code: input.code, name: input.name, type: input.type, is_contra: input.isContra };
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val);
    sets.push(`${col} = $${values.length}`);
  }
  const { rows } = await pool.query<GlAccountRow>(`UPDATE gl_accounts SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`, values);
  return rows.length ? rowToAccount(rows[0]!) : null;
}

export class SystemAccountProtectedError extends Error {
  constructor() {
    super("This is a system account used by automatic postings and can't be deleted.");
    this.name = "SystemAccountProtectedError";
  }
}

export async function deleteGlAccount(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const existing = await getGlAccount(pool, orgId, id);
  if (!existing) return false;
  if (existing.isSystem) throw new SystemAccountProtectedError();
  const { rowCount } = await pool.query(`DELETE FROM gl_accounts WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}

// ผังบัญชีขั้นต่ำที่การโพสต์ fixed asset ต้องใช้ — acquisition (1500/2100),
// depreciation (6100/1590), disposal (1590/1100/7100/1500), และ adjustments
// (1500/3900) เป็น idempotent คือข้าม code ที่มีอยู่แล้ว เรียกซ้ำได้เรื่อย ๆ
// อย่างปลอดภัยและไม่เปลืองทรัพยากร (เช่น เรียกก่อนทุกครั้งที่จะโพสต์)
const DEFAULT_ACCOUNTS: { code: string; name: string; type: GlAccountType; isContra?: boolean }[] = [
  { code: "1100", name: "Cash / Bank", type: "asset" },
  { code: "1500", name: "Fixed Assets", type: "asset" },
  { code: "1590", name: "Accumulated Depreciation", type: "asset", isContra: true },
  { code: "2100", name: "Accounts Payable", type: "liability" },
  { code: "3900", name: "Asset Adjustments", type: "equity" },
  { code: "6100", name: "Depreciation Expense", type: "expense" },
  { code: "7100", name: "Gain / Loss on Disposal", type: "expense" },
];

export async function ensureDefaultAccounts(pool: Pool, orgId: string): Promise<GlAccountRecord[]> {
  const existing = await listGlAccounts(pool, orgId);
  const existingCodes = new Set(existing.map((a) => a.code));
  for (const def of DEFAULT_ACCOUNTS) {
    if (existingCodes.has(def.code)) continue;
    await createGlAccount(pool, orgId, { code: def.code, name: def.name, type: def.type, isContra: def.isContra ?? false }, true);
  }
  return listGlAccounts(pool, orgId);
}
