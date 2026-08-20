// การล็อคงวดบัญชี — ปีบัญชีที่ยังไม่มี row ใน fiscal_periods ถือว่าเปิดอยู่
// (ค่า default ของ isFiscalYearClosed) ดังนั้นองค์กรที่เพิ่งสร้างใหม่ไม่ต้อง
// ตั้งค่าอะไรก่อนที่จะ post journal entry แรกได้เลย จะมี row เกิดขึ้น
// ก็ต่อเมื่อมีการปิดหรือเปิดปีนั้นอย่างชัดเจนเท่านั้น
import type { Pool } from "pg";

export interface FiscalPeriodRecord {
  fiscalYear: number;
  status: "open" | "closed";
  closedAt: string | null;
  closedBy: string | null;
}

interface FiscalPeriodRow {
  fiscal_year: number;
  status: "open" | "closed";
  closed_at: string | null;
  closed_by: string | null;
}

function rowToPeriod(row: FiscalPeriodRow): FiscalPeriodRecord {
  return { fiscalYear: row.fiscal_year, status: row.status, closedAt: row.closed_at, closedBy: row.closed_by };
}

export async function listFiscalPeriods(pool: Pool, orgId: string): Promise<FiscalPeriodRecord[]> {
  const { rows } = await pool.query<FiscalPeriodRow>(
    `SELECT fiscal_year, status, closed_at, closed_by FROM fiscal_periods WHERE org_id = $1 ORDER BY fiscal_year DESC`,
    [orgId],
  );
  return rows.map(rowToPeriod);
}

export async function isFiscalYearClosed(pool: Pool, orgId: string, fiscalYear: number): Promise<boolean> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM fiscal_periods WHERE org_id = $1 AND fiscal_year = $2`, [orgId, fiscalYear]);
  return rows[0]?.status === "closed";
}

export class FiscalYearOrderError extends Error {
  constructor(year: number) {
    super(`Fiscal year ${year - 1} must be closed before ${year} can be closed.`);
    this.name = "FiscalYearOrderError";
  }
}

// ปีบัญชีต้องปิดตามลำดับ — จะปิดปีถัดไปไม่ได้ถ้าปีก่อนหน้ายังเปิดอยู่แบบชัดเจน
// ถ้าปีก่อนหน้าไม่มี row เลย แปลว่าประวัติบัญชีขององค์กรนี้ไม่ย้อนไปถึงปีนั้น
// จึงไม่ถือเป็นตัวบล็อค จะบล็อคได้ก็ต่อเมื่อมีคนเปิดปีก่อนหน้าไว้แล้วไม่ปิดเท่านั้น
export async function closeFiscalYear(pool: Pool, orgId: string, fiscalYear: number, actorUsername: string): Promise<FiscalPeriodRecord> {
  const { rows: priorRows } = await pool.query<{ status: string }>(`SELECT status FROM fiscal_periods WHERE org_id = $1 AND fiscal_year = $2`, [orgId, fiscalYear - 1]);
  if (priorRows[0] && priorRows[0].status !== "closed") {
    throw new FiscalYearOrderError(fiscalYear);
  }

  const { rows } = await pool.query<FiscalPeriodRow>(
    `INSERT INTO fiscal_periods (org_id, fiscal_year, status, closed_at, closed_by)
     VALUES ($1, $2, 'closed', now(), $3)
     ON CONFLICT (org_id, fiscal_year) DO UPDATE SET status = 'closed', closed_at = now(), closed_by = $3
     RETURNING fiscal_year, status, closed_at, closed_by`,
    [orgId, fiscalYear, actorUsername],
  );
  return rowToPeriod(rows[0]!);
}

export async function openFiscalYear(pool: Pool, orgId: string, fiscalYear: number): Promise<FiscalPeriodRecord> {
  const { rows } = await pool.query<FiscalPeriodRow>(
    `INSERT INTO fiscal_periods (org_id, fiscal_year, status)
     VALUES ($1, $2, 'open')
     ON CONFLICT (org_id, fiscal_year) DO UPDATE SET status = 'open', closed_at = NULL, closed_by = NULL
     RETURNING fiscal_year, status, closed_at, closed_by`,
    [orgId, fiscalYear],
  );
  return rowToPeriod(rows[0]!);
}
