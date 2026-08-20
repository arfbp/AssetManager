-- ให้ admin ของ org (หรือ platform admin) ระงับ user ได้โดยไม่ต้องลบ
-- account/history ทิ้ง — ทำตาม organizations.status เป๊ะๆ
-- (migrations/0001_organizations.sql) ซึ่งมี pattern นี้อยู่แล้ว แต่ users
-- ยังไม่มี column แบบนี้จนถึงตอนนี้
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
