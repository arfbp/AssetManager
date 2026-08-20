-- Multi-tenant migration เฟส 1: org_id บนทุกตารางที่ scope ตาม tenant
-- backfill ลงไปที่ legacy org เพื่อให้ fleet เดียวที่ใช้อยู่วันนี้ยังทำงานได้
-- เหมือนเดิม เพิ่ม NOT NULL หลัง backfill เท่านั้น อยู่ใน statement group
-- เดียวกัน เพื่อไม่ให้โค้ดฝั่งแอปมองเห็นคอลัมน์นี้เป็น nullable ได้เลย
--
-- ตั้งใจข้าม sessions ไป — org หาได้จาก users.org_id (เหมือนกับ role ที่อ่าน
-- สดผ่าน join อยู่แล้ว ไม่ได้ duplicate ลงบนแถว session) ตั้งใจข้าม
-- ip_geolocation_cache ไปด้วย — เป็น cache IP->location ระดับ global ไม่มี
-- ข้อมูลที่ผูกกับ tenant ไหนเป็นพิเศษ agent ของหลาย org ที่อยู่หลัง office IP
-- เดียวกันแชร์แถวเดียวกันได้ตามปกติ

ALTER TABLE users ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE agents ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE agents SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE agents ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE telemetry_snapshots ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE telemetry_snapshots SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE telemetry_snapshots ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE command_history ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE command_history SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE command_history ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE assets ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE assets SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE assets ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE device_incidents ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE device_incidents SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE device_incidents ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE asset_connection_history ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE asset_connection_history SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE asset_connection_history ALTER COLUMN org_id SET NOT NULL;
