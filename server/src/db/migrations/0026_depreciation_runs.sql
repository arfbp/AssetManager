-- Fixed-asset accounting เฟส 4: depreciation run — node "Depreciation
-- Calculation" และ "Depreciation Posting" ในไดอะแกรมคือสถานะสองสถานะของ
-- run เดียวกัน (draft -> posted) ไม่ใช่สอง entity แยกกัน period เป็น NULL
-- หมายถึง run รายปี; 1-12 หมายถึงเดือนปฏิทินเดือนเดียว journal_entry_id จะ
-- ถูกตั้งค่าก็ต่อเมื่อ posted แล้วเท่านั้น — draft run ยังไม่กระทบ GL ดังนั้น
-- ทิ้ง (ลบ) ได้อย่างอิสระก่อนจะ post
CREATE TABLE IF NOT EXISTS depreciation_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  fiscal_year      INTEGER NOT NULL,
  period           INTEGER,
  run_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  status           TEXT NOT NULL DEFAULT 'draft',
  journal_entry_id UUID REFERENCES journal_entries(id),
  total_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_depreciation_runs_org ON depreciation_runs (org_id, fiscal_year, period);

-- FK แบบ composite ไปที่ (org_id, asset_tag) pattern เดียวกับ
-- maintenance_records (migrations/0006/0015) — primary key ของ assets เป็น
-- คู่ composite ไม่ใช่ asset_tag เดี่ยวๆ
CREATE TABLE IF NOT EXISTS depreciation_run_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organizations(id),
  asset_tag         TEXT NOT NULL,
  amount            NUMERIC(14,2) NOT NULL,
  book_value_before NUMERIC(14,2) NOT NULL,
  book_value_after  NUMERIC(14,2) NOT NULL,
  CONSTRAINT depreciation_run_lines_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_depreciation_run_lines_run ON depreciation_run_lines (run_id);
CREATE INDEX IF NOT EXISTS idx_depreciation_run_lines_asset ON depreciation_run_lines (org_id, asset_tag);
