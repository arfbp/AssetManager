-- Asset Management ERP เฟส 1: vendors (ซัพพลายเออร์ที่ purchase order สั่งไป)
-- และ purchase order เอง เป็นตารางใหม่ ดังนั้น org_id เป็น NOT NULL ตั้งแต่
-- แรก (ต่างจากการ backfill ตารางเก่าใน 0002_org_id_backfill.sql) —
-- ไม่มีข้อมูลเดิมที่ต้อง migrate
CREATE TABLE IF NOT EXISTS vendors (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  name         TEXT NOT NULL,
  contact_name TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_org ON vendors (org_id, name);

-- status บังคับที่ฝั่งแอป (zod) ไม่ใช่ CHECK constraint — ธรรมเนียมเดียวกับ
-- assets.status: draft -> pending_approval -> approved|rejected และแยกอีกทาง
-- approved -> received (หรือ cancelled ได้ตลอดก่อนถึงจุดนั้น)
-- po_number ("PO-0001") เรียงลำดับต่อ org เหมือน assets.asset_tag จึงต้องใช้
-- ความ unique แบบ (org_id, po_number) แทนที่จะเป็นคอลัมน์ unique เดี่ยวๆ
-- vendor_id ไม่มี ON DELETE clause (default เป็น RESTRICT-like NO ACTION) —
-- ธรรมเนียมเดียวกับ "ทุก FK ใน schema นี้ตั้งใจไม่ cascade เว้นแต่แถวลูกจะไม่มี
-- ตัวตนอิสระของตัวเอง" ตามที่บันทึกไว้ใน deleteOrganization ของ
-- orgsStore.ts
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id),
  po_number               TEXT NOT NULL,
  vendor_id               UUID NOT NULL REFERENCES vendors(id),
  status                  TEXT NOT NULL DEFAULT 'draft',
  requested_by            TEXT NOT NULL,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  order_date              DATE,
  expected_delivery_date  DATE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org ON purchase_orders (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders (vendor_id);

-- Line item เป็นของ PO ของมันโดยสมบูรณ์ (ไม่มีตัวตนอิสระของตัวเอง) ดังนั้น
-- นี่คือ FK เดียวใน migration นี้ที่ cascade จริง — ลบ PO แล้วต้องลบ item
-- ของมันไปด้วย ต่างจากตารางอื่นๆ ที่ scope ตาม org ใน schema นี้ที่ตั้งใจ
-- บล็อกการลบไว้ (ดู doc comment ของ deleteOrganization ว่าทำไม default
-- ถึงต่างกัน)
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  purchase_order_id  UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description        TEXT NOT NULL,
  quantity           INTEGER NOT NULL DEFAULT 1,
  unit_cost          NUMERIC(12,2) NOT NULL DEFAULT 0,
  asset_category     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items (purchase_order_id);
