-- เก็บ action ของ platform-admin ไว้ถาวร (org create/rename/suspend/delete,
-- cross-org password reset, resend-invite, custom-domain change) เพื่อให้
-- มองเห็นได้จาก dashboard ไม่ใช่แค่ audit logger ของ Pino ที่ออกทาง stdout
-- อย่างเดียว (ดู export `audit` ใน server/src/logger.ts) จำกัดขอบเขตเฉพาะ
-- action ของ platform-admin เท่านั้น ไม่ใช่กิจกรรมทั่วไปต่อ org — ดู
-- การตัดสินใจออกแบบ audit-log ใน plan ของ multi-tenant migration
--
-- org_id ใช้ ON DELETE SET NULL ไม่ใช่ RESTRICT — การลบ org ต้องไม่ถูกบล็อก
-- โดย หรือทำให้ audit history ของตัวเองหายไป ชื่อของ org จะถูก snapshot ลง
-- ใน `details` เพื่อให้ event ยังอ่านเข้าใจได้แม้ org นั้นจะถูกลบไปแล้ว
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_username TEXT NOT NULL,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (created_at DESC);
