# OptiFleet Central Server

Backend ของฟลีต OptiFleet AI: เป็น WebSocket hub สำหรับเอเจนต์ Go, HTTP API
สำหรับแดชบอร์ด, ตัวแปลคำสั่งภาษาธรรมชาติด้วย LLM (ผ่าน Groq) และ security
guardrail ที่ตัดสินใจว่าอะไรบ้าง — ถ้ามี — ที่จะถูกส่งไปยังอุปกรณ์จริง

## ทำไมใช้ Groq ไม่ใช่เรียก Anthropic/OpenAI ตรงๆ

`src/llm/actionParser.ts` เรียก Groq's Chat Completions endpoint ที่เข้ากันได้
กับ OpenAI ผ่าน SDK `openai` ตัวเดียวกัน แค่ override `baseURL` — ทำให้ได้ทั้ง
ความเร็วของ inference บน Groq และความเข้ากันได้กับ ecosystem ของ OpenAI SDK
(tool use, forced tool_choice, strict schema) โดยไม่ต้องเขียน client เอง
ถ้าจะสลับไปเรียก provider อื่นที่มี API เข้ากันได้กับ OpenAI ก็แค่เปลี่ยน
`baseURL` กับ API key ส่วนที่เหลือของ pipeline (schema, guardrail, dispatch)
ไม่ผูกกับ provider ใดเป็นพิเศษ ไม่ต้องแก้อะไรเพิ่ม

## การตัดสินใจออกแบบที่สำคัญที่สุดในนี้: LLM ไม่มีสิทธิ์สร้างเนื้อหาที่รันได้เอง

`src/llm/actionParser.ts` ใช้ tool use ของ LLM โดยบังคับ `tool_choice` ให้
เรียก tool เดียวเท่านั้น และตั้ง `strict: true` บน schema (`src/llm/schema.ts`)
โมเดลตอบกลับได้แค่ 5 ฟิลด์ที่กำหนดไว้ตายตัวเท่านั้น — `action` (enum ปิด),
`target`, `scope`, `confirm`, `reasoning` — ไม่มีทางตอบเป็นข้อความอิสระ
ไม่มีทางสั่ง action ที่เอเจนต์ไม่รองรับ และไม่มีทางส่งเนื้อหาสคริปต์มาเองได้

นี่คือความตั้งใจ และเป็นเหตุผลที่ `uninstall_software` ทำงานแบบที่เป็นอยู่:
โมเดลแค่แยกแยะว่า *แอปไหน* ที่ผู้ใช้พูดถึง ส่วนคำสั่งลบจริงๆ มาจากตารางเล็กๆ
ที่มนุษย์ตรวจสอบไว้แล้ว (`src/llm/uninstallTemplates.ts`) โดย key ด้วยชื่อแอป
ถ้าแอปไม่อยู่ในตารางนั้น คำขอจะถูกปฏิเสธ — โมเดลไม่มีสิทธิ์แต่งสคริปต์ uninstall
เอง หลักการเดียวกันนี้ยังกันไม่ให้ `run_script` ถูกสั่งผ่านช่องทางภาษาธรรมชาติ
ได้เลย (ดู `src/security/guardrail.ts`): เนื้อหาสคริปต์ไม่มีรูปแบบที่จำกัด
ขอบเขตได้แบบที่ PID/ชื่อของ `kill_process` มี จึงไม่มีทางอนุมานจากข้อความ
อิสระได้อย่างปลอดภัย ไม่ว่าตัว parser จะดีแค่ไหน flow "รันสคริปต์นี้" ที่
แท้จริงต้องให้มนุษย์เขียนและส่งสคริปต์เข้ามาตรงๆ — เป็น endpoint ที่ repo นี้
ตั้งใจยังไม่สร้าง

ผลลัพธ์จาก parser **ไม่เคยถูกถือเป็นการอนุมัติ** — ดู comment เรื่อง trust
boundary ที่ต้นไฟล์ `actionParser.ts` ทุกอย่างที่สำคัญ (การไล่หา scope,
การเป็นสมาชิก allowlist, การสแกน blacklist, ต้องขอ confirm หรือไม่) ถูก
คำนวณใหม่อย่างเป็นอิสระใน `src/security/guardrail.ts` ซึ่งเป็นด่านเดียวที่
คั่นระหว่าง "โมเดลบอกว่าโอเค" กับคำสั่งที่เซ็นแล้วจริงๆ ไปถึงอุปกรณ์

## เส้นทางคำขอ (`POST /api/command`)

```
ข้อความจากแดชบอร์ด
  -> parseNaturalLanguageCommand()   LLM tool use, บังคับเรียก, schema เข้มงวด
  -> evaluateParsedIntent()          guardrail: ไล่หา scope, blacklist, ประตูขอ confirm
  -> blocked:              422, ไม่ส่งอะไรออกไป
  -> needs_confirmation:   202 + pendingId ผู้ใช้ต้อง POST /api/command/:id/confirm ภายใน 5 นาที
  -> allowed:               ส่งออกทันที เซ็นแล้วส่งไปทุกเป้าหมายที่ไล่หาได้
```

**เมื่อไหร่ที่ต้องขอ confirm** (`src/security/guardrail.ts`):
- `restart_host` / `uninstall_software`: ต้อง confirm เสมอ เว้นแต่ข้อความคำขอ
  เองระบุ confirm มาชัดเจน *และ* เจาะจงอุปกรณ์เดียวเท่านั้น — action ทำลาย
  ล้างที่กระทบหลายเครื่องต้องผ่านการตรวจสอบจากมนุษย์เสมอไม่ว่าจะพูดแบบไหน
- `kill_process`: ขอ confirm เฉพาะเมื่อ scope ที่ไล่หาได้ครอบคลุม 3 เครื่อง
  ขึ้นไป (action ระดับมวลชน)
- `clean_temp`: ไม่ต้องขอเลย เพราะถูกจำกัดด้วย allowlist ไดเรกทอรีของเอเจนต์
  เองอยู่แล้ว
- `run_script`: ไม่มีทางถูกสั่งผ่านช่องทางนี้เลย (ดูด้านบน)

## ความเข้ากันได้ของ wire format กับเอเจนต์ Go

`src/protocol.ts` mirror `internal/transport/protocol.go` ฝั่งเอเจนต์ด้วยมือ
— ไม่มี schema generator ที่ใช้ร่วมกัน ดังนั้นเวลาเพิ่มฟิลด์ฝั่งใดฝั่งหนึ่ง
ต้องแก้อีกฝั่งให้ตรงกันเองด้วย

**การเซ็นคำสั่ง** (`src/crypto/commandSigner.ts`) ใช้รูปแบบ canonical แบบ
netstring (`"<byte-length>:<bytes>"`, สไตล์ Bencode) ไม่ใช่ JSON เพราะ scheme
เซ็นแบบ canonical ที่อิง JSON ต้องทำให้ byte ตรงกับ `json.Marshal` ของ Go
เป๊ะๆ รวมถึงการ escape `<`, `>`, `&` เป็น HTML ที่เป็นค่าเริ่มต้นของมันด้วย
ถึงจะได้ลายเซ็นตรงกันข้ามภาษา ซึ่งเป็นจุดเสี่ยงจริงๆ สำหรับเนื้อหาแบบที่
พารามิเตอร์สคริปต์อาจมี netstring ไม่ต้อง escape อะไรเลย เพราะทุกฟิลด์
ประกาศความยาว byte ของตัวเองไว้ การต่อกันจึงไม่กำกวมไม่ว่าเนื้อหาจะเป็น
อะไร ทั้งสองฝั่งถูกอัปเดตพร้อมกัน — ดู `CanonicalString()` ใน
`internal/transport/protocol.go` ฝั่งเอเจนต์

**การระบุตัวตนเอเจนต์**: ไม่มีข้อความ handshake แยกต่างหาก — ข้อความ
`heartbeat` หรือ `telemetry` แรกของเอเจนต์จะพก `agent_id` (คือ hostname)
มาด้วย และ `src/ws/server.ts` จะลงทะเบียนการเชื่อมต่อภายใต้ ID นั้นตอนนั้น
ตรงกับที่ `transport.Client` ฝั่งเอเจนต์ Go เขียนไว้

**kill_process ด้วยชื่อ**: คำขอภาษาธรรมชาติมักระบุชื่อ process
("โปรแกรมสแกนไวรัส") ไม่ใช่ PID action `kill_process` ของเอเจนต์
(`internal/executor/executor.go`) ถูกขยายให้รับได้ทั้ง `params.pid` หรือ
`params.name` — ชื่อจะถูกจับคู่กับรายการ process ที่กำลังรันอยู่จริงตอน
execution และจะปฏิเสธถ้าตรงกับมากกว่าหนึ่ง process (คืน PID ทั้งหมดที่ตรง
กลับมาให้มนุษย์เลือก) แทนที่จะฆ่าทุกตัวที่ตรงแบบเงียบๆ

## การรัน

```powershell
cd server
npm install
cp .env.example .env    # แล้วแก้ค่า — ดูด้านล่าง
cp config/device-groups.example.json config/device-groups.json   # แล้วแก้ค่า
npm run dev              # tsx watch สำหรับพัฒนา local
# หรือ: npm run build && npm start
```

ต้องมี Node 20+ ติดตั้งไว้ก่อน และรัน `npm run typecheck` หลังติดตั้ง
dependency เสร็จเพื่อจับความไม่ตรงกันของเวอร์ชันที่อาจเกิดขึ้น (บาง
จุดใน `src/llm/` ตั้งใจใช้ structural type ของตัวเองแทนที่จะ import type
จาก SDK โดยตรง เพื่อให้เวอร์ชันไม่ตรงกันแสดง error ที่ type/runtime ชัดเจน
แทนที่จะพังแบบ import ล้มเหลวอย่างงงๆ)

Environment variable ที่จำเป็น — ดู `.env.example` สำหรับรายการเต็มพร้อม
คำอธิบาย:

- `OPTIFLEET_AGENT_AUTH_TOKEN` — bearer token ที่เอเจนต์ใช้ยืนยันตัวตน ต้อง
  ตรงกับ `OPTIFLEET_AUTH_TOKEN` บนเอเจนต์ทุกเครื่อง (`configs/agent.yaml` /
  `internal/config`)
- `OPTIFLEET_HMAC_SECRET` — ต้องตรงกับ `OPTIFLEET_HMAC_SECRET` ของเอเจนต์
  เป๊ะๆ
- `GROQ_API_KEY` — คีย์ฟรีจาก https://console.groq.com/keys
- `OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH` — ประตูฝั่งเซิร์ฟเวอร์ที่แยกต่างหาก
  จากประตู run_script ของเอเจนต์เอง ต้องเป็น true ทั้งคู่ `uninstall_software`
  (ทางเดียวที่ไปถึง run_script ได้) ถึงจะทำงานได้

ใน production ให้ตั้ง `NODE_ENV=production` และ `OPTIFLEET_TLS_CERT_PATH` /
`OPTIFLEET_TLS_KEY_PATH` — `src/config.ts` จะปฏิเสธการสตาร์ทถ้าไม่ตั้งค่านี้
แทนที่จะปล่อยให้เอเจนต์คุยกันผ่าน `ws://` แบบไม่เข้ารหัสแบบเงียบๆ

## ส่วนเสริมสำหรับแดชบอร์ด (สำหรับ `frontend/`)

เพิ่มเข้ามาเพื่อรองรับแดชบอร์ด Next.js:

- **`GET /ws/dashboard`** (`src/ws/dashboardServer.ts`) — WebSocket endpoint
  ตัวที่สอง แยกจาก agent hub ทำหน้าที่ push ข้อความ `agent_update` และ
  `history_entry` แบบเรียลไทม์ไปยังแท็บเบราว์เซอร์ที่เชื่อมต่ออยู่ (บวก
  `snapshot` เต็มตอนเชื่อมต่อครั้งแรก) การยืนยันตัวตนใช้ query param `?token=`
  (เบราว์เซอร์ตั้ง custom header บน native `WebSocket` ไม่ได้) ตรวจสอบกับ
  session จริงของผู้ใช้ใน Postgres (`src/auth/sessions.ts`) — คนละ namespace
  ของ token กับฝั่ง agent hub โดยตั้งใจ
- **`AgentRegistry`** ตอนนี้เก็บเอเจนต์ไว้หลังตัดการเชื่อมต่อแทนที่จะลบทิ้ง
  — จะเปลี่ยนเป็น `status: "offline"` และเก็บ telemetry ล่าสุดไว้ ทำให้
  แดชบอร์ดแสดงอุปกรณ์ที่ติดต่อไม่ได้แทนที่จะหายไปเฉยๆ มันสืบทอดจาก
  `EventEmitter` และ emit `"update"` ทุกครั้งที่สถานะเปลี่ยน ซึ่งเป็นสิ่งที่
  `dashboardServer.ts` subscribe อยู่
- **`CommandHistoryStore`** (`src/history/commandHistory.ts`) — log ในหน่วย
  ความจำแบบจำกัดจำนวน (500 รายการ) ของทุกคำสั่งที่ส่งออกไปพร้อม
  `command_result` สุดท้าย เชื่อมกันด้วย command ID `GET /api/command-history`
  อ่านจากตรงนี้ `dispatchToTargets` เขียนทุกครั้งที่เรียก
- **`POST /api/agents/:id/kill-process`** — ควบคุม process โดยตรงสำหรับปุ่ม
  "Force Close" ใน Task Manager UI ข้าม LLM parser (UI รู้อยู่แล้วว่าต้องการ
  อะไร) แต่ยังผ่านเส้นทาง dispatch ที่เซ็นลายเซ็นเหมือนทุกอย่างอื่น จึงถูก
  audit และบันทึกประวัติเหมือนคำสั่งที่มาจากแชท
- **`POST /api/agents/:id/suggest-remediation`**
  (`src/llm/remediationAdvisor.ts`) — เรียก LLM อีกครั้งแบบเล็กกว่า ดู
  CPU/RAM สดของ process หนึ่งตัวจาก telemetry snapshot ล่าสุด แล้วคืนคำแนะนำ
  รูปแบบ `{suggested_action, reasoning, risk_note}` **ไม่เคยดำเนินการเองเลย**
  — frontend แสดงคำแนะนำแล้วให้ผู้ใช้กดต่อไปที่ kill-process ด้านบนเองถ้า
  เห็นด้วย นี่คือ backend ของปุ่ม "One-Click Auto Remediation": กดครั้งแรก
  เพื่อขอความเห็นจาก AI กดอีกครั้งเพื่อลงมือทำ — ไม่มีทางเป็นคลิกเดียวที่ทั้ง
  ถามและฆ่า process พร้อมกัน
- **ระบบล็อกอินรายผู้ใช้จริง** (`src/auth/`): `POST /api/auth/login`
  ตรวจสอบ username/password (hash ด้วย bcrypt ในตาราง `users`) แล้วออก
  session token แบบ opaque เก็บในตาราง `sessions` — ไม่ใช่ JWT ดังนั้นการเพิก
  ถอนคือ `DELETE` ธรรมดา ไม่ต้องรอวันหมดอายุของลายเซ็น ทุก route `/api/*`
  อื่นต้องมี `Authorization: Bearer <session token>` ตรวจสอบกับตารางนั้นทุก
  request (middleware ระดับ router ใน `src/api/routes.ts`) ไม่มี endpoint
  สมัครสมาชิกสาธารณะ — บัญชีถูกสร้างโดยผู้ดูแลระบบผ่าน `npm run user:create
  -- <username> <password>` `requestedBy` บนทุกคำสั่งที่ส่งออกไปมาจาก session
  ที่ยืนยันตัวตนแล้วฝั่งเซิร์ฟเวอร์ ไม่ได้รับมาจาก request body ดังนั้น
  client จะอ้างว่าเป็นผู้ใช้คนอื่นที่ไม่ใช่คนที่ล็อกอินไว้ไม่ได้
- **CORS** (`src/index.ts`, แพ็กเกจ `cors`): แดชบอร์ดรันคนละ origin
  (`localhost:3000`) กับเซิร์ฟเวอร์นี้ (`localhost:8080`) และทุก REST call
  ที่มันเรียกจะพก header `Authorization` แบบ custom มาด้วย ทำให้เป็น
  CORS-preflighted request เสมอไม่ว่าจะใช้ method ไหน ซึ่งเบราว์เซอร์จะบล็อก
  ฝั่ง client ถ้าไม่ได้รับ `Access-Control-Allow-Origin` กลับมา ตั้งค่า
  `OPTIFLEET_DASHBOARD_ORIGIN` ให้ตรงกับ origin จริงที่ให้บริการแดชบอร์ด
  (คั่นด้วย comma ได้ถ้ามีหลาย origin) — ต้องตรงกับที่แสดงในแถบที่อยู่ของ
  เบราว์เซอร์เป๊ะๆ (scheme + host + port ไม่มี trailing slash) **สิ่งนี้
  มีผลเฉพาะกับเบราว์เซอร์จริงเท่านั้น** — `curl`, `fetch` ของ Node,
  สคริปต์ที่ไม่ใช่ Playwright, และ `Invoke-RestMethod` ของ PowerShell ไม่
  บังคับใช้ CORS เลย ดังนั้นช่องโหว่ตรงนี้จะมองไม่เห็นจาก test ที่ไม่ได้รัน
  ในบริบทเบราว์เซอร์จริง

## การเก็บข้อมูลถาวร (Postgres)

จำเป็นต้องมี — บัญชีผู้ใช้และ session (`src/auth/`) เก็บใน Postgres ไม่ใช่
หน่วยความจำ ดังนั้นการล็อกอินจะไม่มีที่เก็บถ้าไม่มี Postgres ความคงทนของ
telemetry/ประวัติคำสั่งก็อาศัย connection เดียวกันนี้ ตั้งค่า:

```powershell
cp .env.example .env   # แล้วตั้งค่า OPTIFLEET_DATABASE_URL
npm run db:migrate      # รัน src/db/schema.sql (idempotent รันซ้ำได้ปลอดภัย)
npm run user:create -- <username> <password>   # สร้างบัญชีล็อกอินแรก
```

`src/db/persistence.ts` (`wirePersistence` เรียกครั้งเดียวใน `src/index.ts`)
subscribe event `"update"`/`"telemetry"` ตัวเดียวกันบน `AgentRegistry` และ
event `"entry"` บน `CommandHistoryStore` ที่ `ws/dashboardServer.ts` ใช้ push
อัปเดตแบบเรียลไทม์ไปเบราว์เซอร์อยู่แล้ว — ดังนั้นไม่มีส่วนไหนใน
`ws/server.ts`, `api/routes.ts`, หรือ `ws/dispatch.ts` ต้องแก้เพื่อเพิ่มการ
เก็บข้อมูลถาวรเลย มีสามตาราง: `agents` (สถานะปัจจุบัน อัปเดตทับ),
`telemetry_snapshots` (time series แบบ append-only บันทึกทีละแถวต่อ
snapshot — นี่คือสิ่งที่ทำให้กราฟย้อนหลังเป็นไปได้ ไม่ใช่แค่ "รู้ค่าล่าสุด"),
`command_history` (mirror ring buffer ในหน่วยความจำ แต่ไม่จำกัดจำนวนและคงทน)
ทุกการเขียนเป็นแบบ fire-and-forget โดยดัก error แล้ว log ไว้ — Postgres
ล่มจะลดระดับเหลือแค่ "snapshot นี้ไม่ถูกบันทึก" ไม่เคยบล็อกหรือทำให้การจัดการ
เอเจนต์สดหรือการส่งคำสั่งพัง

การออกแบบแบบ single-process นี้เป็นจุดเริ่มต้นที่ถูกต้องก่อนจะขยายไปหลาย
region ดู "การขยายไปมากกว่าหนึ่ง instance" ด้านล่างว่าอะไรจะเปลี่ยนเมื่อ
เอเจนต์ online ข้าม region และเส้นทางเขียน Postgres เดี่ยวกลายเป็นคอขวด
ถัดไป (สิ่งนั้นคือคิวหน้าการเขียน DB ไม่ใช่การคิด schema นี้ใหม่)

## การขยายไปมากกว่าหนึ่ง instance

`src/ws/registry.ts` เป็น `Map` ในหน่วยความจำ — ถูกต้องสำหรับ process
เซิร์ฟเวอร์เดียว แต่ process ที่สองจะมองไม่เห็นเอเจนต์ที่เชื่อมต่อกับ process
แรกเลย การขยายแนวนอนต้องมี registry ที่แชร์กัน (Redis pub/sub เป็นตัวเลือก
ปกติ: publish event connect/disconnect/telemetry แล้วส่งคำสั่งขาออกผ่าน
channel ที่ process ซึ่งถือ socket ของเอเจนต์นั้น subscribe อยู่) คลาส
`AgentRegistry` ถูกออกแบบให้เป็นสิ่งเดียวที่ `src/ws/server.ts` และ
`src/ws/dispatch.ts` คุยด้วยโดยตั้งใจ การสลับแบบนี้จึงจำกัดอยู่ในไฟล์เดียว

## ความเสถียรเมื่อมีเอเจนต์เชื่อมต่อพร้อมกันจำนวนมาก

- `src/ws/server.ts` รัน ping/pong sweep ทุก 30 วินาที และตัดการเชื่อมต่อใดๆ
  ที่ไม่ตอบตั้งแต่ sweep ครั้งก่อน — นี่คือสิ่งที่เคลียร์ socket ที่ค้างครึ่งๆ
  กลางๆ จากปัญหาเครือข่ายชั่วคราวจริงๆ แทนที่จะสะสมไปเรื่อยๆ
- ข้อความผิดรูปแบบหรือมุ่งร้ายจากเอเจนต์ตัวเดียวถูกดักแยกทีละข้อความ
  (`socket.on("message", ...)` ครอบ handler ด้วย try/catch) จึงไม่ทำให้ hub
  ทั้งหมดล่มสำหรับเอเจนต์ตัวอื่นที่เชื่อมต่ออยู่
- `src/index.ts` ติดตั้ง handler `uncaughtException` / `unhandledRejection`
  ที่ log พร้อม context เต็มแล้ว exit — ให้รันภายใต้ process supervisor
  (systemd, pm2, restart policy ของ container) เพื่อให้ความล้มเหลวที่ไม่
  คาดคิดจริงๆ รีสตาร์ทกลับไปสู่สถานะสะอาด แทนที่จะค้างครึ่งๆ กลางๆ

## สิ่งที่ยังไม่ได้ทำโดยตั้งใจ

- flow การส่งสคริปต์ `run_script` จริง (ต้องมี body สคริปต์ชัดเจน + มนุษย์
  review) ตามที่กล่าวข้างต้น
- การเก็บ audit log แบบมีโครงสร้าง — `audit` ตอนนี้ log ออก stdout ผ่าน
  pino (แยกจากตาราง `command_history` ใน Postgres ที่บันทึกแค่ผลลัพธ์การ
  ส่งคำสั่ง ไม่ใช่ audit trail เต็ม) ให้เชื่อม output ของ pino เข้ากับ
  log pipeline ของตัวเองแบบเดียวกับ `audit.log` ของเอเจนต์
- การยืนยันตัวตน/สิทธิ์สำหรับแดชบอร์ดของ `POST /api/command` เอง —
  `requestedBy` ตอนนี้เป็นฟิลด์ข้อความอิสระที่ผู้เรียกใส่มาเอง ไม่ใช่ตัวตนที่
  ยืนยันแล้ว ให้ครอบด้วย auth layer ที่มีอยู่ (SSO, API gateway) ก่อนเปิดให้
  ใช้นอกเครือข่ายภายในที่เชื่อถือได้
</content>
