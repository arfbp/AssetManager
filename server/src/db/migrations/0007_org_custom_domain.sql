-- ให้ org หนึ่งเข้าถึงได้ผ่านโดเมนของตัวเองเต็มรูปแบบ (เช่น
-- assets.360qm.co.th) แทนที่รูปแบบ "<subdomain>.<orgDomainSuffix>" ที่ org
-- อื่นๆ ใช้ร่วมกัน เป็น nullable และไม่ค่อยมีใครใช้โดยตั้งใจ — ส่วนใหญ่ org
-- จะไม่ตั้งค่านี้และใช้ subdomain แบบ sslip.io ที่แชร์กันต่อไป
ALTER TABLE organizations ADD COLUMN custom_domain TEXT;
CREATE UNIQUE INDEX organizations_custom_domain_key ON organizations (lower(custom_domain)) WHERE custom_domain IS NOT NULL;
