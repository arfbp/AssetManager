-- ให้ org อัปโหลดโลโก้ของตัวเองได้ แสดงแทนโลโก้ OptiFleet ค่า default บนหน้า
-- login, sidebar และ favicon ของ org นั้น NULL หมายถึง "ไม่มีโลโก้กำหนดเอง
-- ใช้โลโก้ default" — ตัวไฟล์ภาพจริงเก็บอยู่บนดิสก์ (cfg.orgLogosDir ไฟล์ละ
-- หนึ่งไฟล์ต่อ org คีย์ด้วย org id ไม่มีนามสกุล) คอลัมน์นี้แค่เก็บ
-- content-type จริงไว้ เพื่อให้ GET /orgs/:id/logo ส่ง header ที่ถูกต้องเสมอ
-- โดยไม่ต้องมา sniff ไฟล์ใหม่
ALTER TABLE organizations ADD COLUMN logo_content_type TEXT;
