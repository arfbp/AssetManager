-- Asset Management เฟส 2: ช่องข้อความทั่วไปที่ตั้งชื่อเองได้ 5 ช่อง (เลือก
-- ทางนี้แทนระบบ field-definition แบบ dynamic เต็มรูปแบบ) — org ตั้งชื่อ
-- ช่องไหนก็ได้ในห้าช่องนี้ผ่าน asset_custom_field_labels ช่องที่ไม่ได้ตั้ง
-- label จะไม่แสดงใน UI ที่ไหนเลย ดังนั้น org ที่ไม่ต้องการฟีเจอร์นี้จะไม่เห็น
-- มันเลย
ALTER TABLE assets ADD COLUMN custom_field_1 TEXT;
ALTER TABLE assets ADD COLUMN custom_field_2 TEXT;
ALTER TABLE assets ADD COLUMN custom_field_3 TEXT;
ALTER TABLE assets ADD COLUMN custom_field_4 TEXT;
ALTER TABLE assets ADD COLUMN custom_field_5 TEXT;

CREATE TABLE IF NOT EXISTS asset_custom_field_labels (
  org_id        UUID PRIMARY KEY REFERENCES organizations(id),
  field_1_label TEXT,
  field_2_label TEXT,
  field_3_label TEXT,
  field_4_label TEXT,
  field_5_label TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
