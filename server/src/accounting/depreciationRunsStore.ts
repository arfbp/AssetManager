// Depreciation run คือ entity เดียวที่มีสองสถานะ (draft -> posted)
// ไม่ใช่สอง entity แยกกัน ขั้นตอนคำนวณ (calculate) จะไม่แตะ GL เลย
// จะกระทบ GL ก็ต่อเมื่อ post ผ่าน journalEntriesStore เท่านั้น
import type { Pool } from "pg";
import { monthlyDepreciationAmount } from "../assets/depreciation.js";
import { getAccumulatedDepreciationForAssets } from "../assets/accumulatedDepreciation.js";
import { ensureDefaultAccounts } from "./glAccountsStore.js";
import { createJournalEntry, reverseJournalEntry, type JournalEntryRecord } from "./journalEntriesStore.js";

export interface DepreciationRunLine {
  id: string;
  assetTag: string;
  amount: number;
  bookValueBefore: number;
  bookValueAfter: number;
}

export interface DepreciationRunRecord {
  id: string;
  fiscalYear: number;
  period: number | null;
  runDate: string;
  status: "draft" | "posted" | "reversed";
  journalEntryId: string | null;
  totalAmount: number;
  createdBy: string;
  lines: DepreciationRunLine[];
  createdAt: string;
}

interface RunRow {
  id: string;
  fiscal_year: number;
  period: number | null;
  run_date: string;
  status: "draft" | "posted" | "reversed";
  journal_entry_id: string | null;
  total_amount: string;
  created_by: string;
  created_at: string;
}

interface RunLineRow {
  id: string;
  asset_tag: string;
  amount: string;
  book_value_before: string;
  book_value_after: string;
}

function rowToRun(row: RunRow, lines: DepreciationRunLine[]): DepreciationRunRecord {
  return {
    id: row.id,
    fiscalYear: row.fiscal_year,
    period: row.period,
    runDate: row.run_date,
    status: row.status,
    journalEntryId: row.journal_entry_id,
    totalAmount: Number(row.total_amount),
    createdBy: row.created_by,
    lines,
    createdAt: row.created_at,
  };
}

const RUN_SELECT = `SELECT id, fiscal_year, period, run_date, status, journal_entry_id, total_amount, created_by, created_at FROM depreciation_runs`;

async function getRunLines(pool: Pool, orgId: string, runId: string): Promise<DepreciationRunLine[]> {
  const { rows } = await pool.query<RunLineRow>(
    `SELECT id, asset_tag, amount, book_value_before, book_value_after FROM depreciation_run_lines WHERE org_id = $1 AND run_id = $2 ORDER BY asset_tag ASC`,
    [orgId, runId],
  );
  return rows.map((r) => ({ id: r.id, assetTag: r.asset_tag, amount: Number(r.amount), bookValueBefore: Number(r.book_value_before), bookValueAfter: Number(r.book_value_after) }));
}

export async function listDepreciationRuns(pool: Pool, orgId: string): Promise<DepreciationRunRecord[]> {
  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE org_id = $1 ORDER BY run_date DESC, created_at DESC`, [orgId]);
  const out: DepreciationRunRecord[] = [];
  for (const row of rows) {
    out.push(rowToRun(row, await getRunLines(pool, orgId, row.id)));
  }
  return out;
}

export async function getDepreciationRun(pool: Pool, orgId: string, id: string): Promise<DepreciationRunRecord | null> {
  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE org_id = $1 AND id = $2`, [orgId, id]);
  const row = rows[0];
  if (!row) return null;
  return rowToRun(row, await getRunLines(pool, orgId, id));
}

interface AssetForDepreciation {
  asset_tag: string;
  purchase_cost: string | null;
  purchase_date: string | null;
  depreciation_years: number | null;
  salvage_value: string | null;
}

// สร้างแค่ draft — ยังไม่กระทบ GL จนกว่าจะเรียก postDepreciationRun
// asset ทุกตัวที่มี purchaseCost/purchaseDate/depreciationYears ครบและยังไม่ retired
// จะถูกประเมิน ตัวไหนที่คิดค่าเสื่อมหมดแล้ว (monthlyDepreciationAmount คืน 0)
// จะถูกข้ามไปเลย ไม่ใส่บรรทัดที่มีมูลค่าเป็น 0
export async function calculateDepreciationRun(
  pool: Pool,
  orgId: string,
  input: { fiscalYear: number; period: number | null; runDate?: string | undefined },
  createdBy: string,
): Promise<DepreciationRunRecord> {
  const { rows: assets } = await pool.query<AssetForDepreciation>(
    `SELECT asset_tag, purchase_cost, purchase_date, depreciation_years, salvage_value
     FROM assets
     WHERE org_id = $1 AND status != 'retired' AND purchase_cost IS NOT NULL AND purchase_date IS NOT NULL AND depreciation_years IS NOT NULL`,
    [orgId],
  );
  const accumByAsset = await getAccumulatedDepreciationForAssets(pool, orgId);

  const client = await pool.connect();
  let runId: string;
  let total = 0;
  try {
    await client.query("BEGIN");
    const { rows: runRows } = await client.query<{ id: string }>(
      `INSERT INTO depreciation_runs (org_id, fiscal_year, period, run_date, status, total_amount, created_by)
       VALUES ($1, $2, $3, $4, 'draft', 0, $5) RETURNING id`,
      [orgId, input.fiscalYear, input.period, input.runDate ?? new Date().toISOString().slice(0, 10), createdBy],
    );
    runId = runRows[0]!.id;

    for (const asset of assets) {
      const purchaseCost = Number(asset.purchase_cost);
      const salvageValue = asset.salvage_value === null ? null : Number(asset.salvage_value);
      const alreadyDepreciated = accumByAsset.get(asset.asset_tag) ?? 0;
      const amount = monthlyDepreciationAmount(purchaseCost, asset.depreciation_years, salvageValue, alreadyDepreciated);
      if (amount <= 0) continue;

      const bookValueBefore = purchaseCost - alreadyDepreciated;
      const bookValueAfter = bookValueBefore - amount;
      await client.query(
        `INSERT INTO depreciation_run_lines (run_id, org_id, asset_tag, amount, book_value_before, book_value_after) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, orgId, asset.asset_tag, amount, bookValueBefore, bookValueAfter],
      );
      total += amount;
    }

    await client.query(`UPDATE depreciation_runs SET total_amount = $2 WHERE id = $1`, [runId, total]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return (await getDepreciationRun(pool, orgId, runId))!;
}

export class DepreciationRunNotDraftError extends Error {
  constructor(status: string) {
    super(`This depreciation run is "${status}", not "draft" — only a draft run can be posted.`);
    this.name = "DepreciationRunNotDraftError";
  }
}

export class EmptyDepreciationRunError extends Error {
  constructor() {
    super("This run has nothing to depreciate — every asset is either fully depreciated or has no depreciation fields set.");
    this.name = "EmptyDepreciationRunError";
  }
}

export async function postDepreciationRun(pool: Pool, orgId: string, runId: string, actorUsername: string): Promise<{ run: DepreciationRunRecord; journalEntry: JournalEntryRecord }> {
  const run = await getDepreciationRun(pool, orgId, runId);
  if (!run) throw new Error(`depreciation run not found: ${runId}`);
  if (run.status !== "draft") throw new DepreciationRunNotDraftError(run.status);
  if (run.totalAmount <= 0) throw new EmptyDepreciationRunError();

  const accounts = await ensureDefaultAccounts(pool, orgId);
  const expenseAccount = accounts.find((a) => a.code === "6100")!;
  const accumAccount = accounts.find((a) => a.code === "1590")!;

  const journalEntry = await createJournalEntry(pool, orgId, actorUsername, {
    entryDate: run.runDate,
    source: "depreciation_run",
    sourceId: run.id,
    description: `Depreciation ${run.period ? `for ${run.fiscalYear}-${String(run.period).padStart(2, "0")}` : `for ${run.fiscalYear}`}`,
    lines: [
      { accountId: expenseAccount.id, debit: run.totalAmount, memo: "Depreciation expense" },
      { accountId: accumAccount.id, credit: run.totalAmount, memo: "Accumulated depreciation" },
    ],
  });

  await pool.query(`UPDATE depreciation_runs SET status = 'posted', journal_entry_id = $2 WHERE id = $1 AND org_id = $3`, [runId, journalEntry.id, orgId]);
  return { run: (await getDepreciationRun(pool, orgId, runId))!, journalEntry };
}

export class DepreciationRunNotPostedError extends Error {
  constructor(status: string) {
    super(`This depreciation run is "${status}", not "posted" — only a posted run can be reversed.`);
    this.name = "DepreciationRunNotPostedError";
  }
}

export async function reverseDepreciationRun(pool: Pool, orgId: string, runId: string, actorUsername: string): Promise<DepreciationRunRecord> {
  const run = await getDepreciationRun(pool, orgId, runId);
  if (!run) throw new Error(`depreciation run not found: ${runId}`);
  if (run.status !== "posted" || !run.journalEntryId) throw new DepreciationRunNotPostedError(run.status);

  await reverseJournalEntry(pool, orgId, run.journalEntryId, actorUsername);
  await pool.query(`UPDATE depreciation_runs SET status = 'reversed' WHERE id = $1 AND org_id = $2`, [runId, orgId]);
  return (await getDepreciationRun(pool, orgId, runId))!;
}
