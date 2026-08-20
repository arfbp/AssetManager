// ป้ายชื่อสำหรับช่อง custom-field อเนกประสงค์ 5 ช่องของ asset
// (assets.custom_field_1..5) — หนึ่งแถวต่อ org, upsert ทั้งชุดพร้อมกัน field
// ที่ไม่ได้ตั้งป้ายชื่อไว้จะไม่แสดงที่ไหนใน UI เลย (ดูหน้า org-settings /
// AssetFormModal)
import type { Pool } from "pg";

export interface CustomFieldLabels {
  field1Label: string | null;
  field2Label: string | null;
  field3Label: string | null;
  field4Label: string | null;
  field5Label: string | null;
}

const EMPTY: CustomFieldLabels = { field1Label: null, field2Label: null, field3Label: null, field4Label: null, field5Label: null };

interface LabelsRow {
  field_1_label: string | null;
  field_2_label: string | null;
  field_3_label: string | null;
  field_4_label: string | null;
  field_5_label: string | null;
}

function rowToLabels(row: LabelsRow): CustomFieldLabels {
  return {
    field1Label: row.field_1_label,
    field2Label: row.field_2_label,
    field3Label: row.field_3_label,
    field4Label: row.field_4_label,
    field5Label: row.field_5_label,
  };
}

export async function getCustomFieldLabels(pool: Pool, orgId: string): Promise<CustomFieldLabels> {
  const { rows } = await pool.query<LabelsRow>(
    `SELECT field_1_label, field_2_label, field_3_label, field_4_label, field_5_label FROM asset_custom_field_labels WHERE org_id = $1`,
    [orgId],
  );
  return rows[0] ? rowToLabels(rows[0]) : EMPTY;
}

export async function setCustomFieldLabels(pool: Pool, orgId: string, labels: CustomFieldLabels): Promise<CustomFieldLabels> {
  const { rows } = await pool.query<LabelsRow>(
    `INSERT INTO asset_custom_field_labels (org_id, field_1_label, field_2_label, field_3_label, field_4_label, field_5_label, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (org_id) DO UPDATE SET
       field_1_label = $2, field_2_label = $3, field_3_label = $4, field_4_label = $5, field_5_label = $6, updated_at = now()
     RETURNING field_1_label, field_2_label, field_3_label, field_4_label, field_5_label`,
    [orgId, labels.field1Label || null, labels.field2Label || null, labels.field3Label || null, labels.field4Label || null, labels.field5Label || null],
  );
  return rowToLabels(rows[0]!);
}
