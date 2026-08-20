-- Multi-tenant migration เฟส 4 (ต่อ): asset_tag (แบบ "OF-0001") จะเรียงลำดับ
-- ต่อ org ไม่ unique ทั้งระบบ เมื่อ org_id filtering ทำให้แต่ละ org นับ asset
-- ของตัวเองเริ่มจาก 1 — PRIMARY KEY แบบ global เดี่ยวๆ บน asset_tag จะชนกัน
-- ทันทีที่ลำดับเลขของ org ที่สองไปถึง tag ที่ org ก่อนหน้ามีอยู่แล้ว จัดการ
-- แบบ composite key เดียวกับ agents ใน migrations/0005
-- ข้อกำหนดลำดับ dependency เดียวกับ migrations/0005: FK ขึ้นกับ index ของ
-- assets_pkey ดังนั้นต้องทำก่อน
ALTER TABLE asset_connection_history DROP CONSTRAINT asset_connection_history_asset_tag_fkey;

ALTER TABLE assets DROP CONSTRAINT assets_pkey;
ALTER TABLE assets ADD PRIMARY KEY (org_id, asset_tag);

ALTER TABLE asset_connection_history ADD CONSTRAINT asset_connection_history_org_asset_fkey
  FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE;

DROP INDEX idx_asset_connection_history_asset;
CREATE INDEX idx_asset_connection_history_org_asset ON asset_connection_history (org_id, asset_tag, connected_at DESC);
