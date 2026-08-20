-- Asset Management เฟส 2: การติดตาม software license พร้อมระบบแจ้งเตือนหมด
-- อายุของตัวเอง แยกจาก hardware warranty จำนวนที่นั่งที่ใช้ไปคือ count(*)
-- บน software_license_assignments ตอนอ่าน ไม่ได้เก็บไว้เลย — ท่าทีเดียวกับ
-- "derive อย่าไป cache" ของ book value ใน assets
CREATE TABLE IF NOT EXISTS software_licenses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  name           TEXT NOT NULL,
  vendor_id      UUID REFERENCES vendors(id),
  license_key    TEXT,
  seats          INTEGER,
  purchase_date  DATE,
  expiry_date    DATE,
  cost           NUMERIC(12,2),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_software_licenses_org ON software_licenses (org_id, name);

-- Assignment ไม่มีตัวตนอิสระของตัวเองถ้าไม่มี license (CASCADE) แต่ฝั่ง
-- asset เป็น RESTRICT-like (ไม่มี clause) — เหตุผลแบบ asymmetric-cascade
-- เดียวกับ purchase_order_items เทียบกับ purchase_orders.vendor_id
CREATE TABLE IF NOT EXISTS software_license_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  license_id   UUID NOT NULL REFERENCES software_licenses(id) ON DELETE CASCADE,
  asset_tag    TEXT NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT software_license_assignments_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_software_license_assignments_license ON software_license_assignments (license_id);
CREATE INDEX IF NOT EXISTS idx_software_license_assignments_asset ON software_license_assignments (org_id, asset_tag);
