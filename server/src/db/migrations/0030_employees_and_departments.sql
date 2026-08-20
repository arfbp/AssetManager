-- HR-lite directory ไฟล์นี้พลิกกลับการตัดสินใจของ migrations/0012 ที่ตั้งใจ
-- บอกว่า "ไม่ทำตาราง employee directory แยก" โดยเจตนา: การตัดสินใจนั้นถูกต้อง
-- ตอนที่ "ใครถืออยู่" เป็นแค่ contact string บนแถว asset แต่ผิดเมื่อคนคนเดียว
-- ต้องค้นหาได้ข้าม asset, handover และ request ต่างๆ และต้องอยู่รอดได้แม้
-- ลาออกจากบริษัทไปแล้วโดยไม่ลบประวัติทิ้ง คอลัมน์ free-text ที่ 0012 เพิ่มไว้
-- ไม่ได้ถูก drop — ยังคงอยู่เป็น snapshot ณ ช่วงเวลานั้นควบคู่กับ FK ใหม่
-- (ดูด้านล่าง)

-- Department เป็น entity จริง ไม่ใช่ enum บน employee: เป็นฟิลด์เดียวที่
-- วันนี้ถูกพิมพ์อิสระแยกกันในสามที่ (assets.checked_out_to_department,
-- handovers.employee_department, asset_transfers.to_department) จึงเป็นตัว
-- ที่ต้องการการสะกดแบบเดียวกันมากที่สุด ความ unique แบบไม่สนตัวพิมพ์เล็กใหญ่
-- (functional index แทนที่จะเป็น UNIQUE ธรรมดา) คือตัวป้องกันจริงต่อกรณี
-- "IT" กับ "it" — UNIQUE (org_id, name) ธรรมดาจะปล่อยให้ทั้งคู่ผ่านและสร้าง
-- ความยุ่งเหยิงแบบเดียวกับที่ไฟล์นี้แก้อยู่กลับมาอีก
CREATE TABLE IF NOT EXISTS departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  name       TEXT NOT NULL,
  code       TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_org_name ON departments (org_id, lower(name));

-- status บังคับที่ฝั่งแอป (zod) ไม่ใช่ CHECK constraint — ธรรมเนียมเดียวกับ
-- assets.status และ purchase_orders.status 'inactive' คือวิธีแทนคนที่ลาออก
-- จากบริษัทไปแล้ว: แถวของเขา (และทุก handover, checkout, request ที่ชี้มาที่
-- แถวนั้น) จะถูกเก็บไว้ตลอดไป แค่ถูกกรองออกจาก picker เท่านั้น การ DELETE
-- ถูกบล็อกโดย FK ด้านล่าง และจะขึ้นเป็น 409 บอกให้ operator ปิดใช้งานแทน
--
-- employee_code เป็น nullable และ UNIQUE ต่อ org: Postgres มองว่า NULL แต่ละ
-- ตัวไม่ซ้ำกัน ดังนั้น org ที่ไม่ใช้รหัส HR ก็แค่ปล่อยว่างทุกแถวได้โดยไม่ชน
-- constraint
--
-- user_id เชื่อม employee ใน directory กับบัญชี login OptiFleet ของเขา ถ้ามี
-- เป็น nullable และคาดว่าจะเป็น NULL สำหรับแถวส่วนใหญ่ — พนักงานคลังสินค้าที่
-- รับแล็ปท็อปไปไม่มีบัญชี dashboard หน้าที่เดียวของฟิลด์นี้คือให้ flow การ
-- อนุมัติคำขอ pre-select คนที่ถูกต้องได้ (ดู POST /asset-requests/:id/approve
-- ใน routes.ts)
CREATE TABLE IF NOT EXISTS employees (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  employee_code  TEXT,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  job_title      TEXT,
  department_id  UUID REFERENCES departments(id),
  user_id        UUID REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active',
  start_date     DATE,
  end_date       DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, employee_code)
);
CREATE INDEX IF NOT EXISTS idx_employees_org ON employees (org_id, name);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (org_id, department_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user ON employees (user_id) WHERE user_id IS NOT NULL;

-- ทั้งสาม FK ด้านล่าง: nullable, ไม่มี ON DELETE clause (RESTRICT-like NO
-- ACTION) อ้างอิงด้วย id เดี่ยวๆ ผ่าน join ที่ scope ด้วย org_id เพื่อ
-- defense-in-depth — ธรรมเนียมเดียวกับ assets.vendor_id/purchase_order_id
-- ใน migrations/0029 FK แบบ composite (org_id, X) สงวนไว้สำหรับตารางที่คีย์
-- ด้วย business identity แบบ composite อย่าง asset_tag; employees มี UUID PK
-- ที่ unique ทั้งระบบอยู่แล้ว
--
-- ทุกคอลัมน์ด้านล่างนี้เป็น ADDITIVE ทั้งหมด checked_out_to /
-- checked_out_to_email / checked_out_to_department และ
-- handovers.employee_name/_email/_department ยังอยู่เหมือนเดิม เก็บค่า ณ
-- ช่วงเวลาที่ checkout ไว้ พนักงานที่ย้ายแผนกปีหน้าต้องไม่ไปเขียนทับฟอร์ม
-- handover ที่เซ็นไว้ปีที่แล้วแบบเงียบๆ และแถวที่สร้างก่อน migration นี้ก็ไม่
-- มีอะไรนอกจาก free text นั้น
ALTER TABLE assets ADD COLUMN checked_out_to_employee_id UUID REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_assets_checked_out_employee ON assets (org_id, checked_out_to_employee_id);

ALTER TABLE handovers ADD COLUMN employee_id UUID REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_handovers_employee ON handovers (org_id, employee_id, created_at DESC);

-- แยกออกจาก requested_by ซึ่งยังคงเป็น *login username* ของ OptiFleet ของคน
-- ที่กด "Request" (routes.ts ตั้งค่าจาก req.user!.username) การปนกันนั้น —
-- username ของผู้ขอไหลตรงเข้า assets.checked_out_to และ
-- handovers.employee_name ตอนอนุมัติ — คือสิ่งที่คอลัมน์นี้แยกออกจากกัน: ใคร
-- เป็นคนขอ vs ใครเป็นคนรับจริง ตั้งค่าตอนอนุมัติโดย admin ไม่ใช่ตอนขอ
-- ดังนั้น org ที่ยังไม่มี directory ก็ยังอนุมัติคำขอได้เหมือนเดิมทุกอย่าง
ALTER TABLE asset_requests ADD COLUMN on_behalf_of_employee_id UUID REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_asset_requests_employee ON asset_requests (org_id, on_behalf_of_employee_id);
