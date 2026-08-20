-- Asset Management เฟส 2: การ check-in แบบคลิกเดียวต้องมีวิธีรู้ว่า asset
-- ถูกยืมออกไปอยู่ตอนนี้ โดยไม่พึ่ง assets.checked_out_to เพียงอย่างเดียว
-- (เพราะแก้มือตรงๆ ผ่านฟอร์ม asset ได้เหมือนกัน) NULL หมายถึง "ยังยืมออกอยู่";
-- check-in จะตั้งค่านี้เป็น now() บน handover ที่เปิดอยู่ล่าสุดของ asset นั้น
-- — แถวเดียวกันนี้ยังป้อนเข้า unified per-asset history timeline ใหม่ด้วย
-- (server/src/assets/assetHistory.ts)
ALTER TABLE handovers ADD COLUMN returned_at TIMESTAMPTZ;
