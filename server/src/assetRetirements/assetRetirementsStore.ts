// การจำหน่าย asset แบบเป็นทางการ — แทนที่การแก้ assets.status เป็น 'retired'
// เงียบ ๆ ด้วยบันทึกการจำหน่ายจริง และ (เมื่อมีบัญชี GL แล้ว) journal entry
// การจำหน่ายแบบมาตรฐาน: ตัด asset กับค่าเสื่อมสะสมออกจากบัญชี บันทึกเงินที่ได้
// จากการขาย (ถ้ามี) แล้ว plug ส่วนต่างเป็นกำไรหรือขาดทุน
import type { Pool } from "pg";
import { updateAsset, getAssetByTag } from "../assets/assetsStore.js";
import { getAccumulatedDepreciation } from "../assets/accumulatedDepreciation.js";
import { ensureDefaultAccounts } from "../accounting/glAccountsStore.js";
import { createJournalEntry, type NewJournalEntryLineInput } from "../accounting/journalEntriesStore.js";

export type RetirementReason = "disposed" | "sold" | "lost" | "stolen" | "donated" | "other";

export interface AssetRetirementRecord {
  id: string;
  assetTag: string;
  retirementDate: string;
  reason: RetirementReason;
  disposalMethod: string | null;
  proceeds: number | null;
  notes: string | null;
  journalEntryId: string | null;
  retiredBy: string;
  createdAt: string;
}

interface RetirementRow {
  id: string;
  asset_tag: string;
  retirement_date: string;
  reason: RetirementReason;
  disposal_method: string | null;
  proceeds: string | null;
  notes: string | null;
  journal_entry_id: string | null;
  retired_by: string;
  created_at: string;
}

function rowToRetirement(row: RetirementRow): AssetRetirementRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    retirementDate: row.retirement_date,
    reason: row.reason,
    disposalMethod: row.disposal_method,
    proceeds: row.proceeds === null ? null : Number(row.proceeds),
    notes: row.notes,
    journalEntryId: row.journal_entry_id,
    retiredBy: row.retired_by,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, retirement_date, reason, disposal_method, proceeds, notes, journal_entry_id, retired_by, created_at`;

export async function listAssetRetirements(pool: Pool, orgId: string): Promise<AssetRetirementRecord[]> {
  const { rows } = await pool.query<RetirementRow>(`SELECT ${SELECT_COLUMNS} FROM asset_retirements WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(rowToRetirement);
}

export interface AssetRetirementInput {
  assetTag: string;
  reason: RetirementReason;
  disposalMethod?: string | null | undefined;
  proceeds?: number | null | undefined;
  notes?: string | null | undefined;
  retirementDate?: string | undefined;
}

export class AssetAlreadyRetiredError extends Error {
  constructor(assetTag: string) {
    super(`"${assetTag}" is already retired.`);
    this.name = "AssetAlreadyRetiredError";
  }
}

export async function retireAsset(pool: Pool, orgId: string, retiredBy: string, input: AssetRetirementInput): Promise<AssetRetirementRecord> {
  const asset = await getAssetByTag(pool, orgId, input.assetTag);
  if (!asset) throw new Error(`asset not found: ${input.assetTag}`);
  if (asset.status === "retired") throw new AssetAlreadyRetiredError(input.assetTag);

  const retirementDate = input.retirementDate ?? new Date().toISOString().slice(0, 10);
  let journalEntryId: string | null = null;

  // จะโพสต์ entry การจำหน่ายก็ต่อเมื่อ asset มี purchase cost บันทึกไว้จริง —
  // asset ที่ไม่มีข้อมูลการเงินไม่เคยถูกบันทึกลงบัญชีตั้งแต่แรก จึงไม่มีอะไรให้ตัดออก
  if (asset.purchaseCost !== null && asset.purchaseCost > 0) {
    const accumulated = await getAccumulatedDepreciation(pool, orgId, input.assetTag);
    const proceeds = input.proceeds ?? 0;
    // สูตร plug กำไร/ขาดทุน: cost - ค่าเสื่อมสะสม - proceeds ถ้าเป็นบวกคือขาดทุน
    // (debit 7100) ถ้าเป็นลบคือกำไร (credit 7100)
    const gainOrLoss = asset.purchaseCost - accumulated - proceeds;

    const accounts = await ensureDefaultAccounts(pool, orgId);
    const fixedAssets = accounts.find((a) => a.code === "1500")!;
    const accumDepr = accounts.find((a) => a.code === "1590")!;
    const cash = accounts.find((a) => a.code === "1100")!;
    const gainLoss = accounts.find((a) => a.code === "7100")!;

    const lines: NewJournalEntryLineInput[] = [{ accountId: fixedAssets.id, credit: asset.purchaseCost, memo: "Remove asset cost" }];
    if (accumulated > 0) lines.push({ accountId: accumDepr.id, debit: accumulated, memo: "Remove accumulated depreciation" });
    if (proceeds > 0) lines.push({ accountId: cash.id, debit: proceeds, memo: "Disposal proceeds" });
    if (Math.round(gainOrLoss * 100) !== 0) {
      if (gainOrLoss > 0) lines.push({ accountId: gainLoss.id, debit: gainOrLoss, memo: "Loss on disposal" });
      else lines.push({ accountId: gainLoss.id, credit: -gainOrLoss, memo: "Gain on disposal" });
    }

    const entry = await createJournalEntry(pool, orgId, retiredBy, {
      entryDate: retirementDate,
      source: "asset_retirement",
      sourceId: input.assetTag,
      description: `Retirement of ${input.assetTag} (${input.reason})`,
      lines,
    });
    journalEntryId = entry.id;
  }

  await updateAsset(pool, orgId, input.assetTag, { status: "retired" });

  const { rows } = await pool.query<RetirementRow>(
    `INSERT INTO asset_retirements (org_id, asset_tag, retirement_date, reason, disposal_method, proceeds, notes, journal_entry_id, retired_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [orgId, input.assetTag, retirementDate, input.reason, input.disposalMethod ?? null, input.proceeds ?? null, input.notes ?? null, journalEntryId, retiredBy],
  );
  return rowToRetirement(rows[0]!);
}
