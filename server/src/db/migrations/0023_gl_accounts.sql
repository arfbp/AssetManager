-- Fixed-asset accounting เฟส 1: chart of accounts แบบขั้นต่ำ type บังคับที่
-- ฝั่งแอป (zod) ไม่ใช่ CHECK constraint — ธรรมเนียมเดียวกับคอลัมน์แบบ
-- status/enum อื่นๆ ทุกตัวใน schema นี้ is_contra ทำเครื่องหมายบัญชีอย่าง
-- Accumulated Depreciation ที่ลดยอดคงเหลือปกติของ type ตัวเอง (บัญชีประเภท
-- asset ที่ทำตัวเหมือนยอด credit) — ใช้เพื่อแสดงผลเท่านั้น ไม่เปลี่ยนวิธี
-- การลง debit/credit จริง is_system ทำเครื่องหมาย 7 บัญชีที่
-- ensureDefaultAccounts ใน server/src/accounting/glAccountsStore.ts สร้างให้
-- อัตโนมัติ เพื่อให้ UI ป้องกันไม่ให้ถูกลบโดยไม่ตั้งใจ
CREATE TABLE IF NOT EXISTS gl_accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  is_contra  BOOLEAN NOT NULL DEFAULT false,
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_gl_accounts_org ON gl_accounts (org_id, code);
