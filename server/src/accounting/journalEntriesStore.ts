// Journal entry แบบบัญชีคู่ (double-entry) — เป็นจุดเดียวที่การโพสต์ GL ทุกแบบ
// ในโมดูลนี้ต้องผ่าน (acquisition, depreciation, adjustment, disposal)
// เพื่อให้กติกา "ทุกการโพสต์ต้องยอด balance และเคารพการล็อคงวดบัญชี" บังคับใช้
// อยู่ที่เดียวพอ
import type { Pool } from "pg";
import { isFiscalYearClosed } from "./fiscalPeriodsStore.js";

export interface JournalEntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface JournalEntryRecord {
  id: string;
  entryDate: string;
  fiscalYear: number;
  source: string;
  sourceId: string | null;
  description: string;
  status: "posted" | "reversed";
  reversesEntryId: string | null;
  createdBy: string;
  lines: JournalEntryLine[];
  totalDebit: number;
  createdAt: string;
}

interface EntryRow {
  id: string;
  entry_date: string;
  fiscal_year: number;
  source: string;
  source_id: string | null;
  description: string;
  status: "posted" | "reversed";
  reverses_entry_id: string | null;
  created_by: string;
  created_at: string;
}

interface LineRow {
  id: string;
  journal_entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
  memo: string | null;
}

function rowToLine(row: LineRow): JournalEntryLine {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    debit: Number(row.debit),
    credit: Number(row.credit),
    memo: row.memo,
  };
}

function rowToEntry(row: EntryRow, lines: JournalEntryLine[]): JournalEntryRecord {
  return {
    id: row.id,
    entryDate: row.entry_date,
    fiscalYear: row.fiscal_year,
    source: row.source,
    sourceId: row.source_id,
    description: row.description,
    status: row.status,
    reversesEntryId: row.reverses_entry_id,
    createdBy: row.created_by,
    lines,
    totalDebit: lines.reduce((sum, l) => sum + l.debit, 0),
    createdAt: row.created_at,
  };
}

const ENTRY_SELECT = `SELECT id, entry_date, fiscal_year, source, source_id, description, status, reverses_entry_id, created_by, created_at FROM journal_entries`;
const LINE_SELECT = `SELECT jel.id, jel.journal_entry_id, jel.account_id, ga.code AS account_code, ga.name AS account_name, jel.debit, jel.credit, jel.memo
                      FROM journal_entry_lines jel JOIN gl_accounts ga ON ga.id = jel.account_id`;

// fiscalYear/sourceId เป็น filter อิสระต่อกัน ถ้าใส่มาทั้งคู่จะรวมด้วย AND —
// ใช้ pattern เดียวกับ assetsStore.ts's updateAsset คือสร้าง WHERE แบบ dynamic
// แต่ bind ค่าด้วย parameter เสมอ (ส่วนที่ hardcode มีแค่รูปแบบคอลัมน์/clause
// ไม่ใช่ค่าที่มาจาก user)
export async function listJournalEntries(pool: Pool, orgId: string, fiscalYear?: number, sourceId?: string): Promise<JournalEntryRecord[]> {
  const where: string[] = ["org_id = $1"];
  const params: unknown[] = [orgId];
  if (fiscalYear) {
    params.push(fiscalYear);
    where.push(`fiscal_year = $${params.length}`);
  }
  if (sourceId) {
    // source_id ของรายการ reversal คือ id ของ entry ต้นฉบับ ไม่ใช่สิ่งที่
    // entry ต้นฉบับถูก tag ไว้เอง (เช่น asset tag) — ดู reverseJournalEntry
    // ด้านล่าง ถ้าไม่มี OR นี้ รายการ reversal จะหายไปจาก audit trail ของ
    // asset ที่มันควรอยู่ด้วยแบบเงียบ ๆ
    params.push(sourceId);
    const p = `$${params.length}`;
    where.push(`(source_id = ${p} OR reverses_entry_id IN (SELECT r.id FROM journal_entries r WHERE r.org_id = $1 AND r.source_id = ${p}))`);
  }

  const { rows: entryRows } = await pool.query<EntryRow>(
    `${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY entry_date DESC, created_at DESC`,
    params,
  );
  if (entryRows.length === 0) return [];

  // ดึงเฉพาะ line ของ entry ที่ query กลับมาจริง ๆ เท่านั้น ถ้าดึงทุก line
  // ในทั้ง org จะเปลืองโดยใช่เหตุเมื่อกรองด้วย fiscalYear และจะยิ่งเว่อร์
  // เมื่อกรองแค่ entry ไม่กี่รายการของ asset เดียว
  const { rows: lineRows } = await pool.query<LineRow>(
    `${LINE_SELECT} WHERE jel.org_id = $1 AND jel.journal_entry_id = ANY($2::uuid[]) ORDER BY jel.id ASC`,
    [orgId, entryRows.map((r) => r.id)],
  );
  const linesByEntry = new Map<string, JournalEntryLine[]>();
  for (const row of lineRows) {
    const list = linesByEntry.get(row.journal_entry_id) ?? [];
    list.push(rowToLine(row));
    linesByEntry.set(row.journal_entry_id, list);
  }
  return entryRows.map((row) => rowToEntry(row, linesByEntry.get(row.id) ?? []));
}

export async function getJournalEntry(pool: Pool, orgId: string, id: string): Promise<JournalEntryRecord | null> {
  const { rows: entryRows } = await pool.query<EntryRow>(`${ENTRY_SELECT} WHERE org_id = $1 AND id = $2`, [orgId, id]);
  const row = entryRows[0];
  if (!row) return null;
  const { rows: lineRows } = await pool.query<LineRow>(`${LINE_SELECT} WHERE jel.org_id = $1 AND jel.journal_entry_id = $2 ORDER BY jel.id ASC`, [orgId, id]);
  return rowToEntry(row, lineRows.map(rowToLine));
}

export class UnbalancedJournalEntryError extends Error {
  constructor(totalDebit: number, totalCredit: number) {
    super(`Journal entry does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}.`);
    this.name = "UnbalancedJournalEntryError";
  }
}

export class FiscalYearClosedError extends Error {
  constructor(fiscalYear: number) {
    super(`Fiscal year ${fiscalYear} is closed — this can't be posted into it.`);
    this.name = "FiscalYearClosedError";
  }
}

export interface NewJournalEntryLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
}

export interface NewJournalEntryInput {
  entryDate: string;
  source: string;
  sourceId?: string | null;
  description: string;
  lines: NewJournalEntryLineInput[];
}

// จุดเดียวที่การโพสต์ GL ทุกแบบในโมดูลนี้ไหลผ่าน — ตรวจยอด balance,
// เช็คการล็อคงวดบัญชี แล้วเขียน header+lines แบบ transaction ฟังก์ชันโพสต์
// อื่น ๆ (acquisition, depreciation, adjustment, disposal) ล้วนเรียกฟังก์ชันนี้
// โดยส่งแค่บัญชีและคำอธิบายของตัวเองเข้ามา
export async function createJournalEntry(pool: Pool, orgId: string, createdBy: string, input: NewJournalEntryInput): Promise<JournalEntryRecord> {
  const totalDebit = input.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
  const totalCredit = input.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);
  if (Math.round((totalDebit - totalCredit) * 100) !== 0) {
    throw new UnbalancedJournalEntryError(totalDebit, totalCredit);
  }

  const fiscalYear = new Date(input.entryDate).getFullYear();
  if (await isFiscalYearClosed(pool, orgId, fiscalYear)) {
    throw new FiscalYearClosedError(fiscalYear);
  }

  const client = await pool.connect();
  let entryId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, entry_date, fiscal_year, source, source_id, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'posted', $7)
       RETURNING id`,
      [orgId, input.entryDate, fiscalYear, input.source, input.sourceId ?? null, input.description, createdBy],
    );
    entryId = rows[0]!.id;
    for (const line of input.lines) {
      await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, org_id, account_id, debit, credit, memo) VALUES ($1, $2, $3, $4, $5, $6)`, [
        entryId,
        orgId,
        line.accountId,
        line.debit ?? 0,
        line.credit ?? 0,
        line.memo ?? null,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return (await getJournalEntry(pool, orgId, entryId))!;
}

export class AlreadyReversedError extends Error {
  constructor() {
    super("This journal entry has already been reversed.");
    this.name = "AlreadyReversedError";
  }
}

// สร้าง entry กลับด้านโดยสลับ debit/credit ของทุก line ลงวันที่วันนี้เสมอ —
// จะโพสต์เข้าปีบัญชีปัจจุบันเท่านั้น ไม่ backdate ย้อนไปปีของ entry ต้นฉบับ
// เพราะปีนั้นอาจถูกปิดไปแล้ว
export async function reverseJournalEntry(pool: Pool, orgId: string, entryId: string, actorUsername: string): Promise<JournalEntryRecord> {
  const original = await getJournalEntry(pool, orgId, entryId);
  if (!original) throw new Error(`journal entry not found: ${entryId}`);
  if (original.status === "reversed") throw new AlreadyReversedError();

  const today = new Date().toISOString().slice(0, 10);
  const reversal = await createJournalEntry(pool, orgId, actorUsername, {
    entryDate: today,
    source: "reversal",
    sourceId: original.id,
    description: `Reversal of: ${original.description}`,
    lines: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo })),
  });

  await pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1 AND org_id = $2`, [entryId, orgId]);
  await pool.query(`UPDATE journal_entries SET reverses_entry_id = $1 WHERE id = $2 AND org_id = $3`, [entryId, reversal.id, orgId]);

  return (await getJournalEntry(pool, orgId, reversal.id))!;
}
