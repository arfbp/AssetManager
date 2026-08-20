# OptiFleet AI Agent

เอเจนต์พื้นหลัง (background agent) สำหรับบริหารจัดการฟลีตอุปกรณ์ในองค์กร ใช้ทรัพยากรน้อย
ทำหน้าที่เก็บข้อมูล hardware telemetry แบบ dynamic polling และเปิดช่องทางควบคุมแบบเรียลไทม์
สำหรับรับคำสั่งระยะไกลที่ผ่านการยืนยันตัวตนแล้ว เขียนด้วยภาษา Go รันเป็น OS service มาตรฐาน
(Windows Service / launchd daemon / systemd unit)

## แนวคิดการออกแบบที่ควรรู้

- **มองเห็นได้ ไม่ใช่ซ่อนตัว** service จะลงทะเบียนภายใต้ `service.name` ใน
  `configs/agent.yaml` (ค่าเริ่มต้นคือ `OptiFleetAIAgent` / display name
  `OptiFleet AI Agent`) และจะปรากฏตามปกติใน Task Manager, `services.msc`,
  `launchctl list`, หรือ `systemctl status` ตัวเอเจนต์รันแบบไม่มี GUI/tray icon
  ซึ่งเป็นพฤติกรรมมาตรฐานของ background service ทั่วไป แต่จะไม่พยายามซ่อนตัวจาก
  เครื่องมือจัดการ service ของ OS เอง — นี่คือขอบเขตที่ตั้งใจไว้: การซ่อนตัวแบบ
  มองไม่เห็นจริงต้องใช้เทคนิคแบบ rootkit ซึ่งแยกไม่ออกจากมัลแวร์ และโค้ดเบสนี้
  ไม่ได้ทำแบบนั้น
- **ทุกคำสั่งระยะไกลต้องผ่านการตรวจลายเซ็น (signature-verified), อยู่ใน
  allowlist และถูกบันทึก audit log ทุกครั้ง** รวมถึงคำสั่งที่ถูกปฏิเสธด้วย
  (`internal/executor`) ไม่มีอะไรที่เซิร์ฟเวอร์ส่งมาจะถูกรันเป็น shell
  แบบอิสระ — มีเพียง 3 action ที่กำหนดพารามิเตอร์ไว้ชัดเจนใน
  `configs/agent.yaml: commands.allowed` เท่านั้น
- **`restart_host` ต้องมีพารามิเตอร์ `confirm: true` ระบุมาชัดเจน** นอกเหนือจาก
  การตรวจลายเซ็นและ allowlist และจะหน่วงเวลาก่อนทำงานจริง
  (`commands.restart_confirm_delay` ค่าเริ่มต้น 30 วินาที) แทนที่จะทำทันที
- **ข้อมูลลับไม่เก็บไว้ใน YAML config เด็ดขาด** โทเคนยืนยันตัวตนและ secret
  สำหรับเซ็น HMAC จะอ่านจาก environment variable เท่านั้น
  (`OPTIFLEET_AUTH_TOKEN`, `OPTIFLEET_HMAC_SECRET`) — `config.Load` จะปฏิเสธ
  การสตาร์ทถ้าไม่มีค่าทั้งสองนี้

## โครงสร้างโฟลเดอร์

```
cmd/agent/main.go          จุดเริ่มโปรแกรม: parse flag, ผูก service, graceful shutdown
internal/config/           โหลด + validate YAML config (fail closed ไม่ใช่ fail open)
internal/logger/           log แบบ rotate: agent.log (ops) + audit.log (คำสั่งที่รับมา)
internal/telemetry/
  types.go                 โมเดลข้อมูล Snapshot / ProcessInfo / DiskInfo / DeviceInfo
  devices_windows.go        แจงอุปกรณ์ USB/เครื่องพิมพ์/จอที่ต่ออยู่ผ่าน WMI
  devices_darwin.go         แบบเดียวกันแต่ผ่าน system_profiler + lpstat (macOS)
  devices_other.go          stub เปล่าสำหรับแพลตฟอร์มที่ยังไม่รองรับ
  collector.go              อ่านค่า telemetry ครั้งเดียวผ่าน gopsutil (CPU/RAM/disk/process)
  poller.go                 state machine สลับโหมด normal(5 นาที)/alert(10 วินาที)
internal/transport/
  protocol.go                รูปแบบข้อมูลบนสาย: envelope, คำสั่งที่เซ็น HMAC
  client.go                  WebSocket client: TLS/mTLS, reconnect พร้อม backoff, read/write loop
internal/executor/         allowlist คำสั่ง, ตรวจลายเซ็น, ตัวจัดการ action, audit log
  script_windows.go / script_unix.go   สร้าง process แบบไม่มีหน้าต่างสำหรับ run_script
internal/cleanup/          ลบไฟล์ในไดเรกทอรีอย่างปลอดภัย (กัน path-traversal, ใช้ allowlist เท่านั้น)
internal/selfheal/         Self-Healing Engine: เฝ้าดู service, ลบไฟล์ดิสก์อัตโนมัติ, ตรวจ memory leak
  service_ctl_windows.go / service_ctl_unix.go   SCM (x/sys/windows/svc/mgr) เทียบกับ systemctl/launchctl
  workingset_windows.go / workingset_unix.go     trim EmptyWorkingSet (เฉพาะ Windows) เทียบกับ no-op
internal/svc/               wrapper ของ kardianos/service (วงจร Start/Stop)
configs/agent.yaml          ค่า config เริ่มต้น
scripts/                    สคริปต์ช่วย build + install (Windows/macOS)
```

## dynamic polling ทำงานอย่างไร (`internal/telemetry/poller.go`)

ใช้ timer เดียวขับเคลื่อนการเก็บข้อมูล — ไม่ใช่ ticker สองตัวที่แข่งกัน —
ดังนั้นเมื่อสลับโหมดจะมีผลตั้งแต่รอบตื่นถัดไปทันที:

- **โหมดปกติ**: เก็บข้อมูล + รายงานทุก `polling.normal_interval` (ค่าเริ่มต้น 5 นาที)
- ทันทีที่มีการอ่านค่าครั้งใดครั้งหนึ่งที่ CPU หรือ RAM ≥ ค่า threshold (ค่าเริ่มต้น 85%)
  เอเจนต์จะสลับไปโหมด **alert**: เก็บข้อมูล + รายงานทุก `polling.alert_interval`
  (ค่าเริ่มต้น 10 วินาที)
- จะกลับไปโหมดปกติก็ต่อเมื่อมีการอ่านค่าติดต่อกัน `polling.recovery_streak`
  ครั้ง (ค่าเริ่มต้น 3) ที่ต่ำกว่า threshold แล้วเท่านั้น — hysteresis แบบนี้
  ป้องกันไม่ให้เอเจนต์สลับโหมดถี่ๆ ทุก tick เวลาค่าตัวชี้วัดแกว่งอยู่ใกล้เส้น threshold

## ช่องทางรับคำสั่งทำงานอย่างไร (`internal/transport`, `internal/executor`)

1. เอเจนต์เชื่อมต่อไปยัง `server.url` (ต้องเป็น `wss://`) ด้วย mTLS client cert
   (แนะนำ) หรือ bearer token แล้วคงการเชื่อมต่อไว้ด้วย ping/pong และ
   reconnect แบบ exponential backoff
2. เซิร์ฟเวอร์ส่ง envelope แบบ `command` มา: `{id, action, params, issued_at_unix,
   signature}` โดย `signature` คือ HMAC-SHA256 ของ canonical JSON ของ
   `{id, action, params, issued_at_unix}` เซ็นด้วย secret ที่แชร์กันใน
   `OPTIFLEET_HMAC_SECRET` — เอเจนต์คำนวณซ้ำและเทียบค่าเองในเครื่อง ดังนั้น
   แม้ relay ตรงกลางจะถูกยึด ก็ไม่สามารถปลอมหรือแก้ไขคำสั่งระหว่างทางได้
   แม้ตัว WebSocket session เองจะผ่านการยืนยันตัวตนแล้วก็ตาม
3. `Executor.Handle` ตรวจตามลำดับ: ความถูกต้องของลายเซ็น → ความสดใหม่ของ
   timestamp (ปฏิเสธคำสั่งที่เก่ากว่า 2 นาทีหรือมาจากอนาคต) → การเป็นสมาชิกใน
   allowlist → ตรวจความปลอดภัยเฉพาะ action นั้นๆ (รายชื่อ process
   ที่ป้องกันไว้สำหรับ `kill_process`, allowlist ของไดเรกทอรีสำหรับ
   `clean_temp`, ต้องระบุ confirm ชัดเจนสำหรับ `restart_host`)
4. ทุกขั้นตอนจะถูกเขียนลง `audit.log` ไม่ว่าจะยอมรับ ปฏิเสธ หรือทำงานล้มเหลว
   ก่อนจะส่ง `command_result` กลับไปยังเซิร์ฟเวอร์

## Self-Healing Engine (`internal/selfheal`)

ลูปทำงานอัตโนมัติสามชุด ผูกเข้ากับ `runAgent` ใน [cmd/agent/main.go](cmd/agent/main.go)
ทุกอย่างที่ลูปเหล่านี้กระทำมาจาก **config ในเครื่อง** เท่านั้น (`self_heal:` ใน
`configs/agent.yaml`) กำหนดไว้ตอน deploy ไม่มีส่วนไหนที่ขยายได้ผ่านคำสั่งจาก
เซิร์ฟเวอร์ในขณะรัน — นี่คือขอบเขตความไว้วางใจที่แคบกว่าช่องทางคำสั่งระยะไกลใน
`internal/executor` โดยตั้งใจ: คำสั่งจากเซิร์ฟเวอร์ที่ถูกยึดหรือเป็นอันตราย
ทำได้แค่สิ่งที่ `commands.allowed` อนุญาตเท่านั้น ส่วนลูป self-healing
ก็แตะได้แค่สิ่งที่ `self_heal:` ระบุไว้เท่านั้นเช่นกัน

- **เฝ้าดู service** (`watchdog.go`): poll แต่ละ service ใน
  `self_heal.services.watch` ทุก `check_interval` (ค่าเริ่มต้น 1 นาที) ผ่าน
  API จัดการ service จริงของ OS — `golang.org/x/sys/windows/svc/mgr` บน
  Windows, `systemctl`/`launchctl` บน Linux/macOS — แล้วสตาร์ตใหม่ถ้าหยุดทำงาน
  มีเพดาน `max_restarts_per_hour` แบบ rolling (ค่าเริ่มต้น 5) เพื่อไม่ให้
  พยายามสู้กับ crash loop จริงๆ ไม่รู้จบ เมื่อเกินเพดานแล้วจะหยุดแตะ service
  นั้นและส่งแจ้งเตือน `restart_suppressed` ดังๆ แทนที่จะยอมแพ้เงียบๆ
- **ลบไฟล์ดิสก์อัตโนมัติ** (`disk_cleanup.go`): ทุกครั้งที่เก็บ telemetry
  snapshot ถ้าพื้นที่ว่างของดิสก์ใดต่ำกว่า
  `self_heal.disk_cleanup.free_threshold_percent` (ค่าเริ่มต้น 10%) จะเคลียร์
  ทุกไดเรกทอรีใน `commands.clean_temp_allowed_dirs` — allowlist ชุด
  *เดียวกัน* กับที่คำสั่ง `clean_temp` จากระยะไกลใช้ ผ่านแพ็กเกจ
  `internal/cleanup` ตัวเดียวกัน จึงมี implementation ที่ป้องกัน
  path-traversal อยู่ชุดเดียวไม่ต้องคอยดูแลให้ตรงกันสองชุด มี `cooldown`
  (ค่าเริ่มต้น 15 นาที) กันไม่ให้รันซ้ำทุก poll tick
- **ตรวจ memory leak** (`memory_leak.go`, `memory_monitor.go`): ติดตาม RSS
  ของ process อันดับต้นๆ ในแต่ละ snapshot แล้วตั้งธงเมื่อ process ใดมี
  หน่วยความจำโตขึ้นต่อเนื่องทางเดียวถึง
  `self_heal.memory_leak.growth_threshold_mb` (ค่าเริ่มต้น 500MB) ขึ้นไป
  ตลอด `min_samples` (ค่าเริ่มต้น 5) ครั้งติดต่อกัน — พีคขึ้นครั้งเดียวไม่ทำให้
  ตั้งธง ต้องโตต่อเนื่องทิศทางเดียวเท่านั้น เมื่อตั้งธงแล้วจะ (1) เรียก
  `EmptyWorkingSet` บน Windows เพื่อลด footprint หน่วยความจำจริงของ process
  (`workingset_windows.go`; บน Linux/macOS เป็น no-op ที่ตั้งใจไว้ ดูด้านล่าง)
  และ (2) ส่งแจ้งเตือน `memory_leak_suspected` ไปยังเซิร์ฟเวอร์
  **จะไม่ฆ่าหรือรีสตาร์ต process เองเด็ดขาด** — สัญญาณจาก heuristic การโต
  ของหน่วยความจำยังไม่น่าเชื่อถือพอที่จะทำลายงานที่ยังไม่บันทึกของผู้ใช้ใน
  Excel หรือแท็บเบราว์เซอร์แบบเงียบๆ เซิร์ฟเวอร์สามารถส่งคำสั่ง
  `kill_process` ที่เซ็นและระบุชัดเจนได้ ถ้ามนุษย์หรือ policy ตัดสินใจว่า
  จำเป็น

ทั้งสามลูปรายงานสิ่งที่ทำผ่านข้อความประเภทใหม่ `alert`
(`transport.AlertPayload` / `Client.SendAlert`) แบบ fire-and-forget เพราะ
จุดประสงค์หลักของ self-healing คือกู้คืนได้เองโดยไม่ต้องพึ่งว่าเซิร์ฟเวอร์
จะเชื่อมต่อได้หรือไม่

### คำสั่ง `run_script` — อ่านก่อนเปิดใช้งาน

action `run_script` ใน `internal/executor` รันเนื้อหา PowerShell/cmd/bash/sh
ที่เซิร์ฟเวอร์ส่งมาตรงๆ ในสิทธิ์ SYSTEM/root โดยไม่มีหน้าต่างคอนโซล
(`script_windows.go` / `script_unix.go`) นี่ต่างจากคำสั่งอื่นทุกตัวโดย
สิ้นเชิง: `kill_process`, `clean_temp`, และ `restart_host` มีขอบเขตพฤติกรรม
ที่กำหนดไว้ในโค้ดชัดเจน — พารามิเตอร์ปรับได้แค่ภายในขอบเขตปลอดภัยที่เอเจนต์
เองบังคับไว้ ส่วน `run_script` พฤติกรรม *คือ* สิ่งที่สคริปต์บอกให้ทำ
เอเจนต์ตรวจสอบเนื้อหาไม่ได้เหมือนที่ตรวจ action รูปแบบตายตัว

จึง **ปิดไว้เป็นค่าเริ่มต้น** และมีประตูกั้นสองชั้นก่อนจะทำงานได้:

1. ต้องเพิ่ม `run_script` ลงใน `commands.allowed` ใน `configs/agent.yaml`
   อย่างชัดเจน
2. ต้องตั้ง environment variable `OPTIFLEET_ENABLE_RUN_SCRIPT=true` ด้วย —
   `config.Load` จะปฏิเสธการสตาร์ทถ้าไม่มีค่านี้ ประตูชั้นที่สองนี้มีไว้เพื่อ
   ไม่ให้การเปิดใช้งานเกิดขึ้นโดยบังเอิญจากการก็อปปี้ไฟล์ config ไปมา

แม้เปิดใช้งานแล้ว ทุกการเรียกยังต้องผ่านการตรวจลายเซ็น+timestamp+allowlist
เหมือนคำสั่งอื่นทุกตัว มี timeout จำกัด (`commands.script_timeout` ค่าเริ่มต้น
5 นาที) และจำกัดขนาด body/output และที่สำคัญคือ **เนื้อหาสคริปต์เต็ม
(SHA-256 + ข้อความตรงๆ) และ stdout/stderr ที่จับได้จะถูกเขียนลง `audit.log`
ทุกครั้งที่พยายามรัน** ไม่ว่าสำเร็จหรือล้มเหลว คำว่า "silent" ในที่นี้หมายถึง
มองไม่เห็นจาก desktop ของผู้ใช้ที่กำลังใช้งานอยู่ ซึ่งเป็นแบบมาตรฐานของ
Windows service อยู่แล้ว (Session 0 ไม่มี desktop ให้แสดงหน้าต่างอยู่แล้วไม่
ว่ากรณีใด) — ไม่ได้แปลว่ามองไม่เห็นจาก log ของคุณเอง และไม่มีส่วนไหนในโค้ด
เบสนี้ที่ข้ามหรือระงับการเขียน audit log นั้น

สิ่งที่เอเจนต์นี้ทำให้ไม่ได้: ตรวจสอบ *เนื้อหา* สคริปต์ว่าปลอดภัยหรือไม่
หรือยืนยันว่ามีมนุษย์อนุมัติสคริปต์นั้นจริงก่อนจะถูกส่งมา นั่นต้องเป็นการ
ควบคุมฝั่งเซิร์ฟเวอร์ — RBAC ว่าใครส่งคำสั่ง `run_script` ได้, ขั้นตอน
review/approve, การจำกัดอัตรา ให้ถือว่าการเปิดใช้ action นี้เท่ากับการมอบ
สิทธิ์ SYSTEM/root เต็มรูปแบบบนทุกเครื่องที่ลงทะเบียนไว้ ให้กับใครก็ตามที่
ควบคุม workflow ฝั่งเซิร์ฟเวอร์นั้น เพราะนั่นคือสิ่งที่มันเป็นจริงๆ

## การ Build

ต้องใช้ Go 1.22 ขึ้นไป

```powershell
go mod tidy
go build -o bin/optifleet-agent.exe ./cmd/agent   # Windows
# หรือ: go build -o bin/optifleet-agent ./cmd/agent  # macOS/Linux
```

รันแบบ local โดยไม่ต้องติดตั้งเป็น service (สะดวกสำหรับพัฒนา):

```powershell
./bin/optifleet-agent.exe -run -config configs/agent.yaml
```

ติดตั้ง/จัดการเป็น service:

```powershell
./bin/optifleet-agent.exe -service install -config configs/agent.yaml
./bin/optifleet-agent.exe -service start   -config configs/agent.yaml
./bin/optifleet-agent.exe -service stop    -config configs/agent.yaml
./bin/optifleet-agent.exe -service uninstall -config configs/agent.yaml
```

หรือใช้ `scripts/install_windows.ps1` (รันแบบ Administrator) /
`scripts/install_macos.sh` (รันด้วย `sudo`) ซึ่ง build และติดตั้งในขั้นตอน
เดียว

ก่อนสตาร์ท service ให้ตั้งค่า secret ที่จำเป็นทั้งสองตัวเป็น environment
variable (ระดับเครื่อง หรือผ่าน secrets manager / MDM — ห้ามใส่ใน
`agent.yaml`):

```powershell
setx OPTIFLEET_AUTH_TOKEN "..."          /M
setx OPTIFLEET_HMAC_SECRET "..."         /M
```

## หมายเหตุเป้าหมายการใช้ทรัพยากร

เป้าหมาย RAM <20MB / CPU <1% ทำได้จริงแต่ไม่ได้เกิดขึ้นเองอัตโนมัติจาก GC
ของ runtime Go ในทางปฏิบัติต้องทำเพิ่ม:

- ตั้ง `GOGC=50` และ/หรือ `GOMEMLIMIT=24MiB` เป็น environment variable บน
  service เพื่อจำกัดการโตของ heap และให้เก็บขยะบ่อยขึ้น (ซึ่งถูก เพราะ heap
  เล็กอยู่แล้ว) แทนที่จะปล่อยให้โต
- Build ด้วย `-ldflags "-s -w"` เพื่อตัด debug info ออก (ไบนารีเล็กลง ไม่ใช่
  RAM ตอนรัน แต่ลด footprint บนดิสก์และเวลาโหลด)
- ต้นทุน RAM ส่วนใหญ่มาจากรายการ process ที่เก็บทุกครั้งที่อ่าน telemetry
  (`polling.top_n_processes`) ซึ่งเป็นต้นทุน CPU หลักตอน `Collect()` ด้วย
  ค่าเริ่มต้น (`0`) จะรายงานทุก process ที่กำลังรัน — แม่นยำ ตรงกับที่ Task
  Manager แสดง แต่กิน footprint สูงสุด ตั้งเป็นจำนวนบวก (10–15 พอสำหรับ
  จับ process ที่ผิดปกติ) เพื่อจำกัดรายงานและแลกความครบถ้วนกับเป้าหมาย
  <20MB/<1%
- ถ้า <20MB ยังตึงเกินไปเมื่อเทียบกับ overhead พื้นฐานของ runtime Go ใน
  ทางปฏิบัติ สถาปัตยกรรมเดียวกัน (state machine ของ poller, allowlist
  คำสั่งที่เซ็นลายเซ็น, executor ที่บันทึก audit log) ย้ายไป Rust ได้ตรงๆ
  โดยใช้ `sysinfo` + `windows-service`/wrapper ของ launchd +
  `tokio-tungstenite` แลกกับโค้ด scaffolding ที่มากกว่าที่ kardianos/service
  ให้มาฟรีใน Go

## สิ่งที่ยังไม่ได้ทำโดยตั้งใจ

- ฝั่งเซิร์ฟเวอร์สำหรับเซ็นคำสั่ง (repo นี้มีแค่ตัวเอเจนต์)
- การส่ง log ไปรวมศูนย์ (log shipping) — `audit.log` และ `agent.log` เป็น
  ไฟล์ local แบบ rotate เอง ต้องเชื่อมเข้ากับ log pipeline ที่มีอยู่เอง
- กลไก auto-update — ตั้งใจไม่ทำในรอบแรกนี้ เพราะเอเจนต์ที่แทนที่ไบนารีของ
  ตัวเองแบบเงียบๆ ได้ ถือเป็นขอบเขตความไว้วางใจเพิ่มเติมที่สำคัญ ควรมีการ
  ออกแบบ signed-release ของตัวเองต่างหาก ไม่ใช่แค่ต่อเพิ่มเข้าไป
</content>
