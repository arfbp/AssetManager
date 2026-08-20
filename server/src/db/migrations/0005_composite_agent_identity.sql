-- Multi-tenant migration เฟส 4: agent_id (hostname ของ OS บนเครื่อง) ไม่
-- unique ข้าม organization — ทำให้ (org_id, agent_id) เป็น primary key จริง
-- ของตาราง agents และอัปเดต FK จริงตัวเดียวที่เคยชี้ไปที่ agent_id เดี่ยวๆ
-- แบบเดิม command_history/assets/device_incidents/asset_connection_history
-- มี org_id ติดมาจาก migration 0002 อยู่แล้ว และตั้งใจไม่ทำ FK ไปยัง
-- agents(agent_id) มาตั้งแต่แรก (asset อาจมีอยู่ก่อน agent ของมัน อุปกรณ์
-- peripheral อาจอยู่ได้นานกว่าคอมพิวเตอร์ที่มันเคยเสียบอยู่ — ดู comment ของ
-- schema.sql เองบนตารางเหล่านั้น) ดังนั้นเหตุผลนั้นไม่กระทบจากการเปลี่ยนแปลง
-- นี้ มีแค่สอง constraint จริงด้านล่างที่ต้องย้าย
-- ต้องทำ FK ก่อน — เพราะมันขึ้นกับ index ของ agents_pkey Postgres จะไม่ยอมให้
-- drop PK ตราบใดที่ยังถูกอ้างอิงอยู่
ALTER TABLE telemetry_snapshots DROP CONSTRAINT telemetry_snapshots_agent_id_fkey;

ALTER TABLE agents DROP CONSTRAINT agents_pkey;
ALTER TABLE agents ADD PRIMARY KEY (org_id, agent_id);

ALTER TABLE telemetry_snapshots ADD CONSTRAINT telemetry_snapshots_org_agent_fkey
  FOREIGN KEY (org_id, agent_id) REFERENCES agents (org_id, agent_id);

DROP INDEX idx_telemetry_agent_time;
CREATE INDEX idx_telemetry_org_agent_time ON telemetry_snapshots (org_id, agent_id, recorded_at DESC);

ALTER TABLE assets DROP CONSTRAINT assets_agent_id_key;
ALTER TABLE assets ADD CONSTRAINT assets_org_agent_key UNIQUE (org_id, agent_id);
