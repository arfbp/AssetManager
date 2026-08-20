-- Asset Management ERP เฟส 1 (ต่อ): ฟิลด์ depreciation/การเงินและการติดตาม
-- warranty บน assets ทั้งหมด nullable/additive สไตล์เดียวกับ
-- 0012_asset_checkout_contact.sql ตัว book value เองไม่ได้เก็บไว้ที่นี่ —
-- คำนวณตอนอ่าน (server/src/assets/depreciation.ts) แนวทางเดียวกับ "live,
-- computed" ที่ใช้กับฟิลด์ที่มาจาก telemetry ของ AssetLiveInfo อยู่แล้ว
-- ทำให้ไม่มีทาง stale ระหว่างการอ่านแต่ละครั้ง
ALTER TABLE assets ADD COLUMN purchase_cost NUMERIC(12,2);
ALTER TABLE assets ADD COLUMN purchase_date DATE;
ALTER TABLE assets ADD COLUMN depreciation_years INTEGER;
ALTER TABLE assets ADD COLUMN salvage_value NUMERIC(12,2);
ALTER TABLE assets ADD COLUMN warranty_expiry_date DATE;
