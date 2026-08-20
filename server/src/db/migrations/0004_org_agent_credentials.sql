-- Multi-tenant migration เฟส 3: agent credentials แยกต่อ org แทนที่
-- OPTIFLEET_AGENT_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET แบบเดียวที่ใช้ร่วมกันทั้ง
-- fleet เป็นแค่ schema เท่านั้น — ค่าจริงของ legacy org จะ backfill ในขั้นตอน
-- แยกที่ไม่ commit เข้า repo (ดึงสดจาก .env ของแต่ละ environment ตอน deploy)
-- ไม่เขียนลงในไฟล์ migration ที่อยู่ใน repo เด็ดขาด
ALTER TABLE organizations ADD COLUMN agent_auth_token TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN agent_hmac_secret TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX ON organizations (agent_auth_token) WHERE agent_auth_token <> '';
