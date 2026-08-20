-- Asset Management เฟส 2: ลายเซ็นบนหน้าจอ + หลักฐานการยอมรับ EULA แบบเสริม
-- ต่อยอดบน transition pending_signature -> acknowledged เดิม แทนที่จะเพิ่ม
-- ค่า status ใหม่ — org ที่ไม่เคยตั้งค่า checkout_eula_text จะไม่เห็นความ
-- เปลี่ยนแปลงใดๆ ต่อ flow พิมพ์แล้วเซ็นจริงบนกระดาษแบบเดิมเลย
ALTER TABLE handovers ADD COLUMN employee_signature TEXT;
ALTER TABLE handovers ADD COLUMN eula_accepted_at TIMESTAMPTZ;

ALTER TABLE organizations ADD COLUMN checkout_eula_text TEXT;
