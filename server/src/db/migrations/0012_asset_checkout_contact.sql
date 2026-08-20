-- เพิ่มความสมบูรณ์ให้ชื่อ checked_out_to แบบ free-text เดิม ด้วยสองฟิลด์ที่
-- สำคัญจริงๆ สำหรับการติดตาม asset ทาง IT แบบ "ใครถืออยู่ ติดต่อยังไง"
-- โดยไม่ต้องสร้างตาราง employee directory แยกต่างหาก (เลือกทางที่เบากว่าและ
-- ชัดเจนกว่า แทนที่จะทำ HR-lite directory เต็มรูปแบบ)
ALTER TABLE assets ADD COLUMN checked_out_to_email TEXT;
ALTER TABLE assets ADD COLUMN checked_out_to_department TEXT;
