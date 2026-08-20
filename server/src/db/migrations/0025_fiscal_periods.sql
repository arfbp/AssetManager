-- Fixed-asset accounting เฟส 3: การล็อกงวดบัญชี ปีที่ไม่มีแถวในนี้ถือว่ายัง
-- เปิดอยู่ (isFiscalYearClosed ใน fiscalPeriodsStore.ts) — แถวจะถูก insert
-- ก็ต่อเมื่อมีการปิดหรือเปิดปีอย่างชัดเจนเท่านั้น ดังนั้น org ใหม่เอี่ยมไม่
-- ต้องตั้งค่าอะไรเลยก่อนที่ journal entry แรกจะ post ได้
CREATE TABLE IF NOT EXISTS fiscal_periods (
  org_id      UUID NOT NULL REFERENCES organizations(id),
  fiscal_year INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  closed_at   TIMESTAMPTZ,
  closed_by   TEXT,
  PRIMARY KEY (org_id, fiscal_year)
);
