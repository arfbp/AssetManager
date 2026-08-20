-- ให้ admin คนแรกของ org ที่เพิ่งสร้างตั้งรหัสผ่านของตัวเองผ่านลิงก์ใช้ครั้ง
-- เดียว แทนที่ platform admin จะเป็นคนตั้งรหัสผ่านแล้วส่งต่อให้เอง
-- (plaintext-password-in-chat) ใช้ได้ครั้งเดียวและมีวันหมดอายุ
CREATE TABLE password_setup_tokens (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX ON password_setup_tokens (user_id);
