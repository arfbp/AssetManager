-- OptiFleet AI Central Server: persistence schema
-- Idempotent (มี IF NOT EXISTS ทุกที่) — รันซ้ำได้อย่างปลอดภัยผ่าน
-- `npm run db:migrate` ดู src/db/migrate.ts

-- จำเป็นสำหรับ gen_random_uuid() ที่ตาราง users ด้านล่างใช้ — บาง version
-- ของ Postgres มีในตัวอยู่แล้ว บาง version ต้องใช้ extension จึง declare
-- ไว้อย่างชัดเจนแทนที่จะเดาว่า database นี้เป็นแบบไหน
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  agent_id       TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  connected_at   TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL,
  last_telemetry JSONB
);

-- Time series แบบ append-only หนึ่งแถวต่อ telemetry snapshot ที่ agent
-- รายงานมา (normal mode ทุก 5 นาที, alert mode ทุก 10 วินาที ตาม dynamic
-- poller ของ agent — ดู internal/telemetry/poller.go) `agents.last_telemetry`
-- ยังคงเป็นค่าที่อ่านได้เร็วสำหรับ "สถานะปัจจุบัน" ตารางนี้คือประวัติที่อยู่
-- เบื้องหลังมัน
CREATE TABLE IF NOT EXISTS telemetry_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  recorded_at TIMESTAMPTZ NOT NULL,
  mode        TEXT NOT NULL,
  cpu_percent DOUBLE PRECISION NOT NULL,
  mem_percent DOUBLE PRECISION NOT NULL,
  mem_used_mb DOUBLE PRECISION NOT NULL,
  mem_total_mb DOUBLE PRECISION NOT NULL,
  snapshot    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_agent_time
  ON telemetry_snapshots (agent_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS command_history (
  command_id    TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  params        JSONB NOT NULL,
  requested_by  TEXT NOT NULL,
  source_text   TEXT,
  status        TEXT NOT NULL,
  message       TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_command_history_dispatched_at
  ON command_history (dispatched_at DESC);

-- บัญชีของแต่ละ user จริงๆ มาแทนที่ OPTIFLEET_DASHBOARD_TOKEN เดียวที่ใช้
-- ร่วมกัน บัญชีถูกสร้างโดย administrator ผ่าน `npm run user:create` — ไม่มี
-- endpoint ให้ self-registration แบบสาธารณะ ตรงกับปรัชญา "ไม่มีความสามารถ
-- ใดๆ นอกเหนือจากที่ operator ตั้งค่าไว้อย่างชัดเจน" ของโปรเจกต์นี้ (ดู doc
-- comment ของ internal/groups/deviceGroups.ts สำหรับหลักการเดียวกันฝั่ง
-- agent)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role-based access control: 'admin' dispatch คำสั่งได้ จัดการ asset ได้
-- และจัดการบัญชี user อื่นได้ด้วย; 'it_support' dispatch คำสั่งและจัดการ
-- asset ได้แต่แตะบัญชี user ไม่ได้; 'viewer' อ่านได้อย่างเดียวทุกที่ (ถูก
-- บล็อกที่ requireRole ใน security/roles.ts ไม่ใช่แค่ซ่อนไว้ใน UI —
-- เบราว์เซอร์ของ Viewer ที่เรียก dispatch endpoint ตรงๆ จะได้ 403 จริง
-- เหมือนคนอื่นทุกคน) แถวที่มีอยู่แล้วจะ default เป็น 'admin' ตอน migration
-- — โปรเจกต์นี้เคยมีแค่บัญชี bootstrap เดียวก่อนที่ role จะมีอยู่ และการ
-- default ให้เป็นอะไรที่ต่ำกว่า admin จะเป็นการล็อกเอาต์แบบไม่ทันตั้งตัว
-- ไม่ใช่ default ที่ปลอดภัย
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'it_support', 'viewer'));

-- Field ข้อมูลโปรไฟล์พื้นฐาน แยกจาก identifier สำหรับ login (username)
-- เป็น nullable — บัญชีที่มีอยู่ก่อนหน้านี้ไม่มีค่าทั้งสองนี้; ฟอร์ม "Add
-- user" ต่อจากนี้ไปจะบังคับกรอกชื่อ/นามสกุล แต่ตรงนี้ไม่ได้บังคับ backfill
-- ให้บัญชีที่มีอยู่แล้ว
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Session token เป็น opaque random string ไม่ใช่ JWT — การเพิกถอนคือแค่
-- DELETE และความถูกต้องคือการ lookup DB แทนที่จะเชื่อ signature ที่
-- เซิร์ฟเวอร์ invalidate ก่อนเวลาไม่ได้ เก็บใน Postgres (ไม่ใช่หน่วยความจำ)
-- เพื่อให้ session รอด server restart แทนที่จะบังคับให้ operator ทุกคน
-- login ใหม่ทุกครั้ง
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- Asset registry — ข้อมูล inventory/procurement ที่ operator กรอกเอง
-- (location, เช็คเอาต์ให้ใคร, order number, end-of-life date) ซ้อนอยู่บน
-- สิ่งที่ agent รายงานเองอัตโนมัติอยู่แล้ว (serial number, model,
-- manufacturer — collectHardwareInfo ของ internal/telemetry ส่วนหนึ่งของ
-- ทุก telemetry snapshot ที่เก็บไว้ใน agents.last_telemetry อยู่แล้ว)
-- agent_id ตั้งใจไม่ทำเป็น foreign key ไปยัง agents(agent_id): asset สามารถ
-- มีอยู่ได้ก่อนที่อุปกรณ์ที่มันอธิบายจะเคย connect (ซื้อมาแล้วแต่ยังไม่ได้
-- deploy — "ready_to_deploy" ด้านล่าง) ดังนั้นการบังคับให้ agents ต้องมีอยู่
-- ก่อนจะทำให้ case นี้พัง
CREATE TABLE IF NOT EXISTS assets (
  asset_tag             TEXT PRIMARY KEY,
  agent_id              TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'ready_to_deploy',
  category              TEXT,
  location              TEXT,
  order_number          TEXT,
  checked_out_to        TEXT,
  checkout_date         DATE,
  expected_checkin_date DATE,
  eol_date              DATE,
  notes                 TEXT,
  -- กรอกด้วยมือตอนลงทะเบียน asset ก่อนที่มันจะเคย connect (ซื้อมาแล้ว วางอยู่
  -- ในกล่อง "ready_to_deploy") — เป็นทางเดียวที่จะบันทึก serial number ไว้
  -- ล่วงหน้าได้ เพราะ serial_number *แบบสด* ที่แสดงในที่อื่นจะมาจาก
  -- telemetry ของ agent ที่เชื่อมโยงกันเสมอ ไม่เคยมาจากตารางนี้ เมื่อ agent
  -- จริงเชื่อมต่อเข้ามาและรายงาน serial ที่ตรงกัน auto-registration ของ
  -- db/persistence.ts จะเชื่อม agent นั้นเข้ากับแถวเดิมนี้ แทนที่จะสร้าง
  -- asset ซ้ำสำหรับอุปกรณ์จริงตัวเดียวกัน
  manual_serial_number  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADD COLUMN IF NOT EXISTS จัดการกรณีที่ตาราง assets มีอยู่แล้วก่อนที่คอลัมน์
-- นี้จะถูกเพิ่มเข้ามา — CREATE TABLE IF NOT EXISTS ด้านบนเป็น no-op กับตาราง
-- ที่มีอยู่แล้ว ดังนั้นแค่ตัวมันเองอย่างเดียวจะไม่มีวัน backfill คอลัมน์ใหม่
-- ลงบน database ที่ provision ไปแล้วได้
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manual_serial_number TEXT;

-- Asset ประเภท 'computer' คือฝั่งหนึ่งของ agent_id link ด้านบน —
-- manufacturer/model/serial ของมันอ่านสดจาก telemetry ของ agent ที่เชื่อมโยง
-- กันเสมอ (join ใน listAssets ของ assetsStore.ts) ไม่เคยเก็บไว้ที่นี่ Asset
-- ประเภท 'peripheral' (เช่นจอมอนิเตอร์) ไม่มี telemetry connection ของ
-- ตัวเองให้ join ดังนั้นตัวตนของมันต้องถูกจับไว้เป็น static snapshot ตอน
-- ลงทะเบียนแทน — จึงเป็นเหตุผลที่มีสองคอลัมน์ด้านล่างนี้ไว้เฉพาะสำหรับ case
-- นั้น และจะเป็น NULL สำหรับแถวประเภท 'computer' parent_agent_id บันทึกว่า
-- peripheral ตัวนี้ต่อผ่านคอมพิวเตอร์เครื่องไหนตอนลงทะเบียน — เป็นข้อมูล
-- อ้างอิงเท่านั้น (peripheral ย้ายไปเครื่องอื่นได้ทีหลังโดยไม่ต้องอัปเดต
-- ค่านี้) จึงตั้งใจไม่ทำเป็น foreign key ไปยัง agents(agent_id)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS asset_type TEXT NOT NULL DEFAULT 'computer';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manufacturer TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;

-- Incident log ต่ออุปกรณ์ — ตอนนี้มีแค่ "process หยุดตอบสนอง" (การเช็ค
-- hung-window ของ Windows เอง ดู internal/telemetry/hungwindows_windows.go)
-- แต่คอลัมน์ `kind` เผื่อพื้นที่ไว้สำหรับ incident type อื่นในอนาคตโดยไม่ต้อง
-- แก้ schema หนึ่งแถวต่อหนึ่ง episode ต่อเนื่อง ไม่ใช่หนึ่งแถวต่อรอบ
-- telemetry poll: db/persistence.ts เปิดแถวเมื่อเห็น process hang ครั้งแรก
-- และปิดมัน (ตั้งค่า resolved_at) เมื่อ process นั้นกลับมาตอบสนองอีกครั้ง
-- หรือ exit ไปแล้ว ติดตามด้วย map ในหน่วยความจำที่คีย์ด้วย agent+pid+name
-- เพื่อไม่ให้ process ที่ยัง hang ต่อเนื่องหลายรอบ poll สแปมแถวใหม่ทุกรอบ
CREATE TABLE IF NOT EXISTS device_incidents (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_incidents_agent_time
  ON device_incidents (agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_assets_agent_id ON assets (agent_id);
CREATE INDEX IF NOT EXISTS idx_assets_manual_serial_number ON assets (manual_serial_number) WHERE manual_serial_number IS NOT NULL;

-- คอมพิวเตอร์เครื่องไหนบ้างที่ asset ประเภท "peripheral" เคยต่อผ่านมาตาม
-- เวลา — assets.parent_agent_id เก็บได้แค่ตัวล่าสุดเท่านั้น (ดู comment ของ
-- คอลัมน์นั้นเอง: "ไม่ได้ sync ต่อทีหลัง") ซึ่งไม่พอแล้วเมื่อ operator
-- ต้องการย้ายจอมอนิเตอร์ไปเครื่องอื่นแต่ยังอยากเห็นว่ามันเคยอยู่ที่ไหนมาก่อน
-- หนึ่งแถวต่อหนึ่ง connection episode ต่อเนื่อง: db/persistence.ts จะปิดแถว
-- ที่เปิดอยู่ (disconnected_at) เมื่อ serial number ของ peripheral ไปโผล่ใน
-- connected_devices ของ agent *ตัวอื่น* (หรือหายไปจากทุกที่) แล้วเปิดแถวใหม่
-- ให้กับที่ที่มันไปโผล่ตอนนี้ ไม่ทำเป็น foreign key ไปยัง agents(agent_id)
-- ด้วยเหตุผลเดียวกับที่ assets.agent_id ไม่ทำ: peripheral อยู่ได้นานกว่า
-- คอมพิวเตอร์เครื่องที่มันเคยต่อผ่าน
CREATE TABLE IF NOT EXISTS asset_connection_history (
  id              BIGSERIAL PRIMARY KEY,
  asset_tag       TEXT NOT NULL REFERENCES assets(asset_tag) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_asset_connection_history_asset
  ON asset_connection_history (asset_tag, connected_at DESC);

-- Public IP จริงที่ WebSocket connection ของ agent มาจาก (ดู connection
-- handler ใน ws/server.ts) — เป็น input ให้กับ IP geolocation ด้านล่าง
-- สำหรับ fleet ที่ deploy บน LAN ค่านี้มักจะเป็น public IP ตัวเดียวของ
-- ออฟฟิศที่ทุกอุปกรณ์ข้างหลังมันใช้ร่วมกัน ไม่ใช่ address ต่ออุปกรณ์ แต่ก็ยัง
-- เก็บแยกต่อ agent เพราะอุปกรณ์ remote/home-office *จะ* มี address ของ
-- ตัวเองที่แตกต่างออกไป และไม่มีทางรู้ได้ว่า case ไหนใช้อยู่ถ้าไม่บันทึกไว้
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_ip TEXT;

-- Cache ผลลัพธ์ external lookup ของ src/geolocation/ipGeo.ts คีย์ด้วย IP
-- เพราะ location ของ IP หนึ่งแทบไม่เคยเปลี่ยนเลย และ agent หลายตัวที่อยู่
-- หลัง office network เดียวกันก็แชร์แถวเดียวกันได้อย่างถูกต้อง is_private
-- ใช้ระบุ address แบบ RFC1918/loopback ที่ไม่เคยถูกส่งไปยัง external API
-- เลย (ไม่มีอะไรต้อง lookup — ดู isPrivateIp ของ ipGeo.ts) แยกจากกรณี
-- lookup ล้มเหลว เพื่อให้ UI แยกแยะ "ไม่มีทาง resolve ได้ตั้งแต่แรก" กับ
-- "ยังไม่ได้ lookup" ออกจากกันได้
CREATE TABLE IF NOT EXISTS ip_geolocation_cache (
  ip           TEXT PRIMARY KEY,
  city         TEXT,
  region       TEXT,
  country      TEXT,
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  is_private   BOOLEAN NOT NULL DEFAULT false,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ระดับรายละเอียดเทียบเท่าเว็บ "what's my IP" ทั่วไป (สไตล์
-- whatismyip.com: ISP, ASN, รหัสไปรษณีย์, timezone คู่กับ
-- city/region/country) — ใช้กับ panel ข้อมูล IP ต่ออุปกรณ์ในหน้า Live
-- Tracking
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS isp TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS asn TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS timezone TEXT;
