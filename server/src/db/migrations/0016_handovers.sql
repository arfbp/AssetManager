-- Asset Management ERP เฟส 2 (ต่อ): บันทึกการส่งมอบสำหรับสั่งพิมพ์เมื่อส่งมอบ
-- asset ให้พนักงาน — status เป็นแบบพิมพ์แล้วเซ็นจริงบนกระดาษ
-- ("pending_signature" -> "acknowledged") ไม่ใช่การเก็บลายเซ็นอิเล็กทรอนิกส์
-- จึงไม่มี signature blob/document เก็บไว้ที่นี่ มีแค่ metadata ของการส่งมอบ
-- เอง FK แบบ composite ไปที่ (org_id, asset_tag) เหมือน maintenance_records
-- ด้านบน
CREATE TABLE IF NOT EXISTS handovers (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  asset_tag                TEXT NOT NULL,
  employee_name            TEXT NOT NULL,
  employee_email           TEXT,
  employee_department      TEXT,
  handover_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  condition_notes          TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending_signature',
  issued_by                TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT handovers_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_handovers_org_asset ON handovers (org_id, asset_tag, created_at DESC);
