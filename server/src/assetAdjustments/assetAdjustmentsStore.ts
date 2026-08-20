// บันทึกการเปลี่ยนแปลงมูลค่า/อายุการใช้งาน/ฟิลด์อื่น ๆ ของ asset พร้อมเหตุผล —
// แทนที่จะแก้ค่าฟิลด์เงียบ ๆ ตรง ๆ ฟังก์ชันนี้จะเขียน log ไว้ และ (เฉพาะกรณี
// field_changed = 'purchase_cost' ซึ่งเป็นชนิดปรับปรุงเดียวที่กระทบ GL)
// จะโพสต์ journal entry ของส่วนต่างให้ balance ด้วย
import type { Pool } from "pg";
import { updateAsset } from "../assets/assetsStore.js";
import { ensureDefaultAccounts } from "../accounting/glAccountsStore.js";
import { createJournalEntry } from "../accounting/journalEntriesStore.js";

export type AdjustmentField = "purchase_cost" | "depreciation_years" | "salvage_value" | "warranty_expiry_date" | "other";

export interface AssetAdjustmentRecord {
  id: string;
  assetTag: string;
  adjustmentDate: string;
  fieldChanged: AdjustmentField;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  adjustedBy: string;
  journalEntryId: string | null;
  createdAt: string;
}

interface AdjustmentRow {
  id: string;
  asset_tag: string;
  adjustment_date: string;
  field_changed: AdjustmentField;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  adjusted_by: string;
  journal_entry_id: string | null;
  created_at: string;
}

function rowToAdjustment(row: AdjustmentRow): AssetAdjustmentRecord {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    adjustmentDate: row.adjustment_date,
    fieldChanged: row.field_changed,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    adjustedBy: row.adjusted_by,
    journalEntryId: row.journal_entry_id,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `id, asset_tag, adjustment_date, field_changed, old_value, new_value, reason, adjusted_by, journal_entry_id, created_at`;

export async function listAssetAdjustments(pool: Pool, orgId: string, assetTag?: string): Promise<AssetAdjustmentRecord[]> {
  const { rows } = assetTag
    ? await pool.query<AdjustmentRow>(`SELECT ${SELECT_COLUMNS} FROM asset_adjustments WHERE org_id = $1 AND asset_tag = $2 ORDER BY created_at DESC`, [orgId, assetTag])
    : await pool.query<AdjustmentRow>(`SELECT ${SELECT_COLUMNS} FROM asset_adjustments WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(rowToAdjustment);
}

export interface AssetAdjustmentInput {
  assetTag: string;
  fieldChanged: AdjustmentField;
  newValue: string;
  reason?: string | null | undefined;
  adjustmentDate?: string | undefined;
}

export async function createAdjustment(pool: Pool, orgId: string, adjustedBy: string, input: AssetAdjustmentInput): Promise<AssetAdjustmentRecord> {
  const { rows: assetRows } = await pool.query<{ purchase_cost: string | null; depreciation_years: number | null; salvage_value: string | null; warranty_expiry_date: string | null }>(
    `SELECT purchase_cost, depreciation_years, salvage_value, warranty_expiry_date FROM assets WHERE org_id = $1 AND asset_tag = $2`,
    [orgId, input.assetTag],
  );
  const asset = assetRows[0];
  if (!asset) throw new Error(`asset not found: ${input.assetTag}`);

  const oldValueMap: Record<AdjustmentField, string | null> = {
    purchase_cost: asset.purchase_cost,
    depreciation_years: asset.depreciation_years === null ? null : String(asset.depreciation_years),
    salvage_value: asset.salvage_value,
    warranty_expiry_date: asset.warranty_expiry_date,
    other: null,
  };
  const oldValue = oldValueMap[input.fieldChanged];

  // ใช้ updateAsset ที่มีอยู่แล้วและผ่านการทดสอบมาแล้วในการแก้ค่าจริง —
  // store นี้แค่เพิ่ม audit trail กับการโพสต์ GL ทับเข้าไปเท่านั้น
  if (input.fieldChanged === "purchase_cost" || input.fieldChanged === "salvage_value") {
    await updateAsset(pool, orgId, input.assetTag, { [input.fieldChanged === "purchase_cost" ? "purchaseCost" : "salvageValue"]: Number(input.newValue) });
  } else if (input.fieldChanged === "depreciation_years") {
    await updateAsset(pool, orgId, input.assetTag, { depreciationYears: Number(input.newValue) });
  } else if (input.fieldChanged === "warranty_expiry_date") {
    await updateAsset(pool, orgId, input.assetTag, { warrantyExpiryDate: input.newValue });
  }

  let journalEntryId: string | null = null;
  if (input.fieldChanged === "purchase_cost") {
    const oldCost = oldValue ? Number(oldValue) : 0;
    const newCost = Number(input.newValue);
    const delta = Math.round((newCost - oldCost) * 100) / 100;
    if (delta !== 0) {
      const accounts = await ensureDefaultAccounts(pool, orgId);
      const fixedAssetsAccount = accounts.find((a) => a.code === "1500")!;
      const adjustmentsAccount = accounts.find((a) => a.code === "3900")!;
      const entry = await createJournalEntry(pool, orgId, adjustedBy, {
        entryDate: input.adjustmentDate ?? new Date().toISOString().slice(0, 10),
        source: "asset_adjustment",
        sourceId: input.assetTag,
        description: `Cost adjustment for ${input.assetTag}: ${oldCost.toFixed(2)} -> ${newCost.toFixed(2)}`,
        lines:
          delta > 0
            ? [
                { accountId: fixedAssetsAccount.id, debit: delta, memo: "Cost increase" },
                { accountId: adjustmentsAccount.id, credit: delta, memo: "Cost increase" },
              ]
            : [
                { accountId: adjustmentsAccount.id, debit: -delta, memo: "Cost decrease" },
                { accountId: fixedAssetsAccount.id, credit: -delta, memo: "Cost decrease" },
              ],
      });
      journalEntryId = entry.id;
    }
  }

  const { rows } = await pool.query<AdjustmentRow>(
    `INSERT INTO asset_adjustments (org_id, asset_tag, adjustment_date, field_changed, old_value, new_value, reason, adjusted_by, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [orgId, input.assetTag, input.adjustmentDate ?? new Date().toISOString().slice(0, 10), input.fieldChanged, oldValue, input.newValue, input.reason ?? null, adjustedBy, journalEntryId],
  );
  return rowToAdjustment(rows[0]!);
}
