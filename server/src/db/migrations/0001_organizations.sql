-- Multi-tenant migration เฟส 1: ตาราง organizations เอง
-- Fleet การใช้งานจริงปัจจุบันกลายเป็น org #1 เป็นแถวปกติ (ไม่ special-case
-- ในโค้ดฝั่งแอป) — ใช้ UUID ตายตัวเพื่อให้ migration backfill ทุกตัวหลังจากนี้
-- อ้างอิงถึงมันเป็น literal constant ได้โดยไม่ต้อง lookup
CREATE TABLE organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  subdomain  TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON organizations (lower(subdomain));

INSERT INTO organizations (id, name, subdomain)
VALUES ('00000000-0000-0000-0000-000000000001', 'Legacy Fleet', 'legacy');
