# OptiFleet AI Dashboard

Frontend ที่ใช้ Next.js (App Router) + Tailwind CSS สำหรับทีมไอทีและผู้บริหาร:
เฝ้าดูสถานะอุปกรณ์แบบเรียลไทม์, คอนโซลคำสั่งภาษาธรรมชาติด้วย AI, และตัวจัดการ
task/process รายเครื่อง คุยกับ `../server` (Central Server) เท่านั้น —
ไม่มีส่วนไหนในแอปนี้ที่เรียก LLM หรือเอเจนต์โดยตรง

## การรัน

```powershell
cd frontend
npm install
cp .env.local.example .env.local   # แล้วแก้ค่า — ต้องตรงกับ server/.env
npm run dev
```

ต้องมี Node 20+ ติดตั้งไว้ก่อน แล้วรัน `npm run typecheck` หลังติดตั้ง
dependency เสร็จ `next-env.d.ts` จะถูกสร้างอัตโนมัติตอนรัน `npm run dev`
หรือ `npm run build` ครั้งแรก เป็นเรื่องปกติที่ไฟล์นี้จะยังไม่มีก่อนหน้านั้น

URL ทั้งสองตัวที่ขึ้นต้นด้วย `NEXT_PUBLIC_*` ใน `.env.local` ต้องชี้ไปที่
ตำแหน่งที่ `server/` กำลังรังฟังอยู่จริง (`OPTIFLEET_HTTP_PORT`) — ดูคำอธิบาย
ใน `.env.local.example` ไม่มี token ให้ต้องจำคู่กันอีกต่อไป: แดชบอร์ดล็อกอิน
กับบัญชีจริงของเซิร์ฟเวอร์ (`src/lib/session.ts`, `server/src/auth/`) แทนที่
จะเป็น secret ที่ฝังไว้ตอน build

## แต่ละความสามารถอยู่ตรงไหน

1. **เฝ้าดูสถานะอุปกรณ์แบบเรียลไทม์** — `src/components/endpoints/`
   (`EndpointGrid` + `EndpointCard`) ป้อนข้อมูลจาก
   `src/hooks/useDashboardSocket.ts` เปิด WebSocket เส้นเดียวไปยัง
   `/ws/dashboard` ของเซิร์ฟเวอร์และรับอัปเดตแบบ push (`agent_update`,
   `history_entry`) — ไม่มี loop polling ที่ไหนในแอปนี้เลย CPU/RAM/Disk
   render เป็น component `Meter` (`src/components/meters/Meter.tsx`);
   Online/Offline เป็น `StatusBadge`
2. **คอนโซลคำสั่งแชท AI + log ประวัติ** — `src/components/chat/ChatConsole.tsx`
   (รับข้อความภาษาธรรมชาติ เรียก `POST /api/command` แสดงผลลัพธ์จาก
   เซิร์ฟเวอร์ว่าส่งแล้ว/ต้อง confirm/ถูกบล็อก) และ
   `src/components/history/CommandHistoryPanel.tsx` (ทุกคำสั่งที่ส่งออกไป —
   จากแชทหรือจากปุ่ม — พร้อมสถานะสำเร็จ/ล้มเหลวแบบสด push ผ่าน WebSocket
   เส้นเดียวกัน)
3. **ตัวจัดการ Task และ Process** — `src/components/process/ProcessManagerDrawer.tsx`
   เปิดโดยคลิกที่การ์ดอุปกรณ์ใดก็ได้ มีสองแท็บ: **Live** แสดงรายการ process
   ของอุปกรณ์จาก telemetry snapshot ล่าสุด (มีปุ่ม **Force Close** ต่อ
   process และปุ่ม **AI suggestion** สำหรับ remediation แบบคลิกเดียว) พร้อม
   panel **อุปกรณ์ที่เชื่อมต่ออยู่** (USB/เครื่องพิมพ์/จอที่ต่ออยู่ตอนนี้
   จัดกลุ่มตามประเภท — ฝั่งเอเจนต์คือ internal/telemetry/devices_*.go);
   **History** คือกราฟแนวโน้ม CPU/RAM/Disk, `src/components/history/HistoryChart.tsx`

## แนวคิดการออกแบบที่ควรรู้

**สีทั้งหมดมาจาก palette อ้างอิงที่กำหนดไว้ตายตัว** ไม่ได้เลือกเอาตามใจ —
ดู `src/app/globals.css` สำหรับนิยาม token และ `tailwind.config.ts` ว่าถูก
เปิดให้ใช้เป็น class ของ Tailwind อย่างไร (`bg-status-critical`,
`text-ink-secondary` ฯลฯ) สีสถานะ (ปกติ/เตือน/severe—ไม่ได้ใช้ในหน้านี้/
วิกฤต) เป็น role ตายตัวของ palette สงวนไว้สำหรับแสดงสถานะเท่านั้น ไม่นำไปใช้
ซ้ำกับอย่างอื่น ทุกตัวบ่งชี้สถานะจับคู่สีกับไอคอน (จุด) *และ* label ข้อความ
เสมอ — สีไม่ใช่สัญญาณเดียว ทั้งเพื่อการเข้าถึงและเพราะจุดสีแดงอย่างเดียวไม่
บอกผู้ดูแลว่าอะไรผิดพลาดจริงๆ

**เกณฑ์ของ Meter ตรงกับจุดแจ้งเตือนของเอเจนต์ Go เอง** ฟังก์ชัน
`severityForPercent()` ใน `src/lib/format.ts` จะเปลี่ยนเป็น "critical" ที่ 85%
— เกณฑ์ CPU/RAM เดียวกันเป๊ะกับที่ทำให้ `internal/telemetry/poller.go` ฝั่ง
เอเจนต์เองสลับไปโหมด alert แบบ poll ทุก 10 วินาที สถานะสีแดงบนแดชบอร์ดกับ
สถานะ "มีอะไรผิดปกติ ต้องดูใกล้ๆ" ของเอเจนต์เองคือตัวเลขเดียวกัน ไม่ใช่
เกณฑ์สองชุดที่เลือกแยกกันแล้วอาจเพี้ยนไปคนละทาง

**"One-click AI auto remediation" ตั้งใจให้เป็นสองคลิก ไม่ใช่คลิกเดียว**
ปุ่ม AI suggestion (`POST /api/agents/:id/suggest-remediation`) คืนแค่คำแนะนำ
เท่านั้น — เหตุผลและ risk note ไม่เคยลงมือทำเอง การนำไปใช้จริงเป็นปุ่มแยก
ต่างหากชัดเจน "Apply: force close" ที่ผ่านเส้นทางเดียวกันเป๊ะกับการคลิก
"Force close" ด้วยมือกับ process อื่นใด ถ้าปุ่มเดียวทั้งถาม AI และฆ่า
process พร้อมกันจะหมายความว่าคำแนะนำที่ผิดหรือหลอน (hallucinate) หนึ่งครั้ง
จะถูกดำเนินการโดยไม่มีมนุษย์คั่นกลาง — เหตุผลเดียวกันนี้ใช้ฝั่งเซิร์ฟเวอร์ด้วย
ดูหมายเหตุเรื่อง guardrail และ confirmation flow ใน `server/README.md`
ปุ่ม "Force close" เองยังมี prompt `confirm()` แบบ native ก่อนส่งอะไรออกไป
เพราะการ force-close process อาจทำให้งานที่ยังไม่บันทึกหายได้ ไม่ว่ามนุษย์
หรือ AI จะเป็นคนเลือกเป้าหมาย

**ธีมเป็นการเลือก ไม่ใช่แค่ media-query สลับสี**
`src/components/theme/ThemeToggle.tsx` วนรอบ light → dark → follow-system
เก็บค่าไว้ใน `localStorage` สคริปต์ inline ใน `<head>` ของ
`src/app/layout.tsx` จะใช้ค่าที่เก็บไว้ก่อน paint แรก จึงไม่มีการกระพริบ
ธีมผิดให้เห็น

## สิ่งที่ยังไม่ได้ทำโดยตั้งใจ

- **ล็อกอินแบบ SSO/OAuth** บัญชีเป็น username+password เท่านั้น
  (`src/components/auth/`, `server/src/auth/`) สร้างโดยแอดมินผ่าน
  `npm run user:create` — ยังไม่เชื่อมกับ identity provider ภายนอก
  `requestedBy` บนทุกคำสั่งที่ส่งออกไปคือ username ที่ยืนยันตัวตนแล้ว
  ไม่ใช่ค่าที่ client ใส่มาเอง ดังนั้นเป็นตัวตนที่ verify จริง แค่ยังไม่มี
  SSO อยู่ด้านหน้าเท่านั้น
- **UI สำหรับส่งสคริปต์ `run_script`** guardrail ฝั่งเซิร์ฟเวอร์ปฏิเสธการ
  ส่ง `run_script` จากช่องทางภาษาธรรมชาติเสมอ (ดู
  `server/src/security/guardrail.ts`) จึงยังไม่มีอะไรให้ frontend นี้แสดง
  — flow "ส่งสคริปต์ที่ผ่านการ review" ในอนาคตต้องมีฟอร์มที่มนุษย์กรอกเอง
  ชัดเจน ไม่ใช่ข้อความแชท
- **กราฟ telemetry / แนวโน้มย้อนหลัง** การ์ดอุปกรณ์และ process drawer แสดง
  แค่ snapshot ล่าสุด — ยังไม่มีที่เก็บข้อมูลแบบ time-series ฝั่งเซิร์ฟเวอร์
  ให้ plot การเพิ่มส่วนนี้ต้องแก้ฝั่งเซิร์ฟเวอร์ก่อน (ดู "สิ่งที่ยังไม่ได้ทำ
  โดยตั้งใจ" ใน `server/README.md`) แล้วค่อยทำกราฟตรงนี้ทีหลังเมื่อมีข้อมูล
  time-series จริงให้ plot
</content>
