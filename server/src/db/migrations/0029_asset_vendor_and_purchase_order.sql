-- Asset Registry <-> ERP linkage: ร่องรอย vendor/PO แบบมีโครงสร้าง ซึ่งเดิม
-- ตัวจัดการ PO-receive ปล่อยไว้แค่เป็น free text ใน assets.notes เท่านั้น
-- ทั้งสอง nullable และไม่ cascade ทั้งคู่ (ไม่มี ON DELETE clause ->
-- RESTRICT-like NO ACTION) ธรรมเนียมเดียวกับ purchase_orders.vendor_id ใน
-- migrations/0013: asset ต้องอยู่รอด -- และต้องบล็อก -- การลบ vendor หรือ PO
-- ที่มันมาจาก แทนที่จะเสีย provenance ไปเงียบๆ
ALTER TABLE assets ADD COLUMN vendor_id UUID REFERENCES vendors(id);
ALTER TABLE assets ADD COLUMN purchase_order_id UUID REFERENCES purchase_orders(id);

CREATE INDEX IF NOT EXISTS idx_assets_vendor ON assets (org_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_assets_purchase_order ON assets (org_id, purchase_order_id);

-- ตัว filter นับ pending-request ใหม่ของ listAssets ใช้ (org_id, asset_tag);
-- index เดิมของ asset_requests คือ (org_id, created_at DESC) ซึ่งรองรับการ
-- lookup นี้ไม่ได้
CREATE INDEX IF NOT EXISTS idx_asset_requests_org_asset ON asset_requests (org_id, asset_tag);
