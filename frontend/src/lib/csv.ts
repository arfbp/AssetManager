// อ่านไฟล์ CSV ที่อัปโหลดมาเป็น text โดยรองรับ encoding ที่ Excel บนเครื่อง
// Windows locale ไทยสร้างออกมาจริง ๆ `File.prototype.text()` จะ decode เป็น
// UTF-8 เสมอ — แต่การ export แบบ "CSV (Comma delimited)" ค่าเริ่มต้นของ Excel
// (ต่างจาก "CSV UTF-8 (Comma delimited)") จะเขียนข้อความไทยด้วย codepage
// Windows-874 แบบ single-byte ไม่ใช่ UTF-8 การ decode ด้วย UTF-8 จะไม่ throw
// error แต่จะทำให้ตัวอักษรไทยทุกตัวกลายเป็น mojibake แบบเงียบ ๆ ซึ่งเป็นอาการ
// "database ไม่รองรับภาษาไทย" ที่ฟังก์ชันนี้มีไว้เพื่อป้องกันโดยตรง ไฟล์ UTF-8 จริง
// (กรณีทั่วไปของคนอื่น รวมถึงผู้ใช้ไทยที่เลือก export แบบ UTF-8) จะ decode ผ่านได้
// ตั้งแต่รอบแรก ส่วนการ decode UTF-8 แบบ strict (`fatal: true`) แทบจะ throw
// เสมอเมื่อเจอ byte ของ Windows-874 จริง ๆ (pattern ของ continuation byte แทบ
// ไม่มีทางบังเอิญตรงกับ UTF-8 ที่ valid) การ fallback ไป Windows-874 เฉพาะตอนที่
// UTF-8 ปฏิเสธ byte เหล่านั้นจึงเป็นสัญญาณที่เชื่อถือได้ ไม่ใช่การเดา
export async function readCsvFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-874").decode(buffer);
  }
}

// CSV parser แบบง่าย ๆ ตามแนว RFC4180 — รองรับ field ที่ครอบด้วยเครื่องหมายคำพูด
// (รวมถึง comma/newline ที่อยู่ข้างในได้) และ escape แบบ doubled-quote
// (เครื่องหมาย "" ภายใน field ที่ quote ไว้หมายถึง " ตัวเดียว) ไม่พึ่ง library
// ภายนอก เพราะมีแค่ Asset Registry import ที่ต้องใช้ ใช้ CSV library จริง ๆ
// จะเกินความจำเป็นสำหรับฟอร์ม bulk-import แค่จุดเดียว
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // ไฟล์ที่ไม่มี newline ปิดท้ายจะยังเหลือ field/row สุดท้ายที่ยังไม่ได้ flush
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// สร้างบรรทัดโดย join แต่ละ field ด้วย comma ใส่เครื่องหมายคำพูดครอบเฉพาะตอนที่
// จำเป็นจริง ๆ (มี comma, quote หรือ newline อยู่ข้างใน) — ทำงานตรงข้ามกับ
// parseCsv ด้านบน
export function toCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(toCsvField).join(",")).join("\r\n");
}
