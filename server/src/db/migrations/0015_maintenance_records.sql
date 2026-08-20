-- Asset Management ERP เฟส 2: log การ maintenance/ซ่อม/ตรวจสอบตามกำหนดต่อ
-- asset หนึ่งชิ้น FK แบบ composite ไปที่ (org_id, asset_tag) — pattern
-- เดียวกับที่ asset_connection_history ใช้ (migrations/0006) เพราะ primary
-- key ของ assets เป็น composite (org_id, asset_tag) ไม่ใช่ asset_tag เดี่ยวๆ
-- status บังคับที่ฝั่งแอป (zod: scheduled|completed|cancelled) — "overdue"
-- ตั้งใจไม่เก็บเป็น status จริง แต่ derive ตอน query
-- (status = 'scheduled' AND scheduled_date < today) ดังนั้นความ overdue ของ
-- record ไม่ต้องมี background job มาคอย sync เลย
CREATE TABLE IF NOT EXISTS maintenance_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  asset_tag       TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'scheduled',
  description     TEXT NOT NULL,
  scheduled_date  DATE,
  completed_date  DATE,
  status          TEXT NOT NULL DEFAULT 'scheduled',
  cost            NUMERIC(12,2),
  performed_by    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_records_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_maintenance_records_org_asset ON maintenance_records (org_id, asset_tag, scheduled_date DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_records_due ON maintenance_records (org_id, status, scheduled_date) WHERE status = 'scheduled';
