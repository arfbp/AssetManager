-- Asset Management เฟส 2: template ที่ใช้ซ้ำได้สำหรับ asset type ที่พบบ่อย
-- (เช่น "Dell Latitude 5440") — ค่าตรงนี้ใช้ PREFILL ฟอร์ม "New asset"
-- แค่ครั้งเดียวเท่านั้น หลังจากนั้นเป็นแค่ข้อมูลอ้างอิง ไม่ sync กันต่อ
-- (ท่าทีเดียวกับ comment ของคอลัมน์ assets.parent_agent_id)
CREATE TABLE IF NOT EXISTS asset_models (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  name                TEXT NOT NULL,
  category            TEXT,
  manufacturer        TEXT,
  model               TEXT,
  depreciation_years  INTEGER,
  salvage_value       NUMERIC(12,2),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_models_org ON asset_models (org_id, name);

-- ไม่มี ON DELETE clause (default เป็น RESTRICT-like NO ACTION) — model ที่
-- เคยเอาไป prefill asset จริงแล้วจะถูกลบทิ้งไปเฉยๆ ไม่ได้ ธรรมเนียมเดียวกับ
-- purchase_orders.vendor_id (migrations/0013)
ALTER TABLE assets ADD COLUMN asset_model_id UUID REFERENCES asset_models(id);
