-- Multi-tenant migration เฟส 2: username จะ unique แค่ภายใน org เดียวกัน
-- ไม่ใช่ทั้งระบบ — org ลูกค้าสอง org ต่างมีบัญชี "admin" ของตัวเองได้เป็นเรื่อง
-- ปกติ และต้องไม่ชนกัน
ALTER TABLE users DROP CONSTRAINT users_username_key;
ALTER TABLE users ADD CONSTRAINT users_org_username_key UNIQUE (org_id, username);
