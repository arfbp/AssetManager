-- Fixed-asset accounting เฟส 6: การเลิกใช้งานอย่างเป็นทางการ — แทนที่การ
-- เปลี่ยน assets.status เป็น 'retired' เงียบๆ ด้วยบันทึกการจำหน่ายจริง และ
-- (เมื่อมี GL accounts แล้ว) journal entry การจำหน่ายที่สมดุล ดู retireAsset
-- ใน assetRetirements/assetRetirementsStore.ts
CREATE TABLE IF NOT EXISTS asset_retirements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  asset_tag        TEXT NOT NULL,
  retirement_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  reason           TEXT NOT NULL,
  disposal_method  TEXT,
  proceeds         NUMERIC(14,2),
  notes            TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  retired_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_retirements_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_retirements_org_asset ON asset_retirements (org_id, asset_tag);
