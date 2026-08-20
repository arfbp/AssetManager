// Asset Models — เทมเพลตที่ใช้ซ้ำได้สำหรับ asset ประเภทที่พบบ่อย (เช่น "Dell
// Latitude 5440") CRUD ปกติ scope ต่อ org รูปแบบเดียวกับ vendors/vendorsStore.ts
// — ฟิลด์ของโมเดลใช้แค่ prefill ฟอร์ม "New asset" ฝั่ง client เท่านั้น
// ไม่มีการ sync กับ asset ที่ถูกสร้างจากโมเดลนี้ในภายหลังแต่อย่างใด
import type { Pool } from "pg";

export interface AssetModelRecord {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  depreciationYears: number | null;
  salvageValue: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AssetModelRow {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  depreciation_years: number | null;
  salvage_value: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToModel(row: AssetModelRow): AssetModelRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    depreciationYears: row.depreciation_years,
    salvageValue: row.salvage_value === null ? null : Number(row.salvage_value),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, name, category, manufacturer, model, depreciation_years, salvage_value, notes, created_at, updated_at`;

export async function listAssetModels(pool: Pool, orgId: string): Promise<AssetModelRecord[]> {
  const { rows } = await pool.query<AssetModelRow>(`SELECT ${SELECT_COLUMNS} FROM asset_models WHERE org_id = $1 ORDER BY name ASC`, [orgId]);
  return rows.map(rowToModel);
}

export interface AssetModelInput {
  name?: string | undefined;
  category?: string | null | undefined;
  manufacturer?: string | null | undefined;
  model?: string | null | undefined;
  depreciationYears?: number | null | undefined;
  salvageValue?: number | null | undefined;
  notes?: string | null | undefined;
}

export async function createAssetModel(pool: Pool, orgId: string, input: AssetModelInput): Promise<AssetModelRecord> {
  const { rows } = await pool.query<AssetModelRow>(
    `INSERT INTO asset_models (org_id, name, category, manufacturer, model, depreciation_years, salvage_value, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SELECT_COLUMNS}`,
    [orgId, input.name ?? "", input.category ?? null, input.manufacturer ?? null, input.model ?? null, input.depreciationYears ?? null, input.salvageValue ?? null, input.notes ?? null],
  );
  return rowToModel(rows[0]!);
}

export async function updateAssetModel(pool: Pool, orgId: string, id: string, input: AssetModelInput): Promise<AssetModelRecord | null> {
  const columns: Record<string, unknown> = {
    name: input.name,
    category: input.category,
    manufacturer: input.manufacturer,
    model: input.model,
    depreciation_years: input.depreciationYears,
    salvage_value: input.salvageValue,
    notes: input.notes,
  };
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }
  const { rows } = await pool.query<AssetModelRow>(`UPDATE asset_models SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`, values);
  return rows.length ? rowToModel(rows[0]!) : null;
}

export async function deleteAssetModel(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM asset_models WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}
