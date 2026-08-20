-- Fixed-asset accounting/operations เฟส 5: log การโอนย้าย นับจริง และปรับปรุง
-- รายการ ทั้งหมด composite-FK ไปที่ (org_id, asset_tag) พร้อม ON DELETE
-- CASCADE — แถวพวกนี้ไม่มีตัวตนอิสระของตัวเองถ้าไม่มี asset ท่าทีเดียวกับ
-- maintenance_records/handovers
CREATE TABLE IF NOT EXISTS asset_transfers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  asset_tag        TEXT NOT NULL,
  from_location    TEXT,
  to_location      TEXT,
  from_department  TEXT,
  to_department    TEXT,
  transfer_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reason           TEXT,
  transferred_by   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_transfers_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_transfers_org_asset ON asset_transfers (org_id, asset_tag, created_at DESC);

-- Count cycle คือการตรวจสอบตามรอบ "asset นี้ยังอยู่จริงตามที่คิดไว้หรือเปล่า"
-- — เริ่มต้นด้วยหนึ่งบรรทัดต่อ asset ที่ active หนึ่งชิ้น (ที่ยังไม่ retired)
-- (startCountCycle ใน assetCounts/assetCountsStore.ts) แต่ละรายการถูกติ๊ก
-- ทีละตัวเมื่อพนักงานตรวจนับจริง
CREATE TABLE IF NOT EXISTS asset_count_cycles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  name       TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date   DATE,
  status     TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  closed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_asset_count_cycles_org ON asset_count_cycles (org_id, started_at DESC);

CREATE TABLE IF NOT EXISTS asset_count_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         UUID NOT NULL REFERENCES asset_count_cycles(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organizations(id),
  asset_tag        TEXT NOT NULL,
  expected_location TEXT,
  counted          BOOLEAN NOT NULL DEFAULT false,
  counted_at       TIMESTAMPTZ,
  counted_by       TEXT,
  actual_location  TEXT,
  discrepancy      BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  CONSTRAINT asset_count_lines_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_count_lines_cycle ON asset_count_lines (cycle_id);

-- journal_entry_id จะถูกตั้งค่าก็ต่อเมื่อ field_changed = 'purchase_cost'
-- (adjustment type เดียวที่กระทบ GL — ดู createAdjustment ใน
-- assetAdjustments/assetAdjustmentsStore.ts) — เป็น null สำหรับการปรับปรุง
-- ฟิลด์ที่ไม่เกี่ยวกับการเงิน เช่น location หรือ note อายุการใช้งาน
CREATE TABLE IF NOT EXISTS asset_adjustments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  asset_tag        TEXT NOT NULL,
  adjustment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  field_changed    TEXT NOT NULL,
  old_value        TEXT,
  new_value        TEXT,
  reason           TEXT,
  adjusted_by      TEXT NOT NULL,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_adjustments_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_adjustments_org_asset ON asset_adjustments (org_id, asset_tag, created_at DESC);
