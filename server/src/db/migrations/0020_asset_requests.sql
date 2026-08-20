-- Asset Management เฟส 2: คำขอแบบ self-service role ที่ authenticated แล้ว
-- ทุกตัว (รวมถึง viewer — เป็น write action เดียวที่ viewer ทำได้ เพราะการ
-- ขอไม่ใช่การกระทำที่ทำลายข้อมูล) ขอ asset ที่ถูกทำเครื่องหมายว่า requestable
-- ได้; admin เป็นคนอนุมัติหรือปฏิเสธ status บังคับที่ฝั่งแอป (zod) รูปแบบ
-- pending->approved|rejected|cancelled แบบไม่มี draft เหมือน purchase_orders
-- (migrations/0013) แค่ไม่มีสถานะ "draft" เพราะที่นี่ไม่มีฟอร์มหลายรายการที่
-- ต้อง save ค้างไว้กลางคัน
ALTER TABLE assets ADD COLUMN is_requestable BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS asset_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  asset_tag     TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_requests_org_asset_fkey
    FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_requests_org ON asset_requests (org_id, created_at DESC);
