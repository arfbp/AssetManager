-- ขยายข้อมูลโปรไฟล์ vendor ให้ครบตามที่ใช้งานจริงในไทย: ชื่อนิติบุคคลตามที่
-- จดทะเบียน + เลขประจำตัวผู้เสียภาษี เงื่อนไขการชำระเงิน/ข้อมูลธนาคาร และ
-- หมวดหมู่ประเภทบริการ ทั้งหมด additive/nullable เหมือน migration ของ field
-- ERP ก่อนหน้าทุกตัว vendor ที่มีอยู่แล้วจะมีค่าว่างจนกว่า operator จะกรอกเอง
ALTER TABLE vendors ADD COLUMN legal_name TEXT;
ALTER TABLE vendors ADD COLUMN tax_id TEXT;
ALTER TABLE vendors ADD COLUMN payment_terms TEXT;
ALTER TABLE vendors ADD COLUMN bank_account_info TEXT;
-- Free text ไม่ใช่ enum — ท่าทีเดียวกับ assets.category: คำศัพท์ของแต่ละ org
-- เอง ("ผู้ขายอุปกรณ์", "ผู้ให้บริการบำรุงรักษา/MA", ...) แทนที่จะเป็น list
-- ตายตัวที่แอปนี้ต้องคอย sync ให้ตรงกับความเป็นจริงตลอด
ALTER TABLE vendors ADD COLUMN category TEXT;
