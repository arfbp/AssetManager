// รูปแบบ wire format ที่ใช้ร่วมกับ Go agent (internal/transport/protocol.go)
// สองไฟล์นี้ต้อง sync กันเองด้วยมือ ไม่มีตัว generate schema ร่วมกันระหว่าง
// โค้ดเบส Go กับ TypeScript ดังนั้น field ที่เพิ่มฝั่งใดฝั่งหนึ่งต้องมาเพิ่ม
// ที่นี่ด้วย

export type MessageType =
  | "heartbeat"
  | "telemetry"
  | "command"
  | "command_result"
  | "command_output"
  | "alert"
  | "self_update"
  | "config_update";

export interface Envelope {
  type: MessageType;
  payload: unknown;
}

export interface HeartbeatPayload {
  agent_id: string;
  uptime_seconds: number;
  // รายงานมาโดย agent build ทุกตัวตั้งแต่มี internal/version — agent เก่าที่
  // deploy มาก่อนหน้านั้นจะไม่มี field นี้เลย ซึ่ง ws/server.ts ถือว่าเป็น
  // "ไม่รู้ ไม่ push update" แทนที่จะเดาเอา
  version?: string;
  // SHA256 ของ agent.yaml ที่ agent โหลดอยู่ตอนนี้ รายงานมาตั้งแต่มี
  // internal/configpush — agent เก่าที่มาก่อนหน้านั้นจะไม่มี field นี้เช่นกัน
  // จัดการแบบเดียวกับ version คือ "ไม่รู้ ไม่ push อะไรทั้งนั้น"
  config_hash?: string;
}

// คำสั่งจากเซิร์ฟเวอร์ไปยัง agent ให้ดาวน์โหลดและติดตั้ง build ใหม่ของตัวเอง
// ดู SelfUpdatePayload ใน internal/transport/protocol.go สำหรับเหตุผลเต็มๆ —
// นี่คือ path ที่แยกออกมาโดยเจตนา และเชื่อถือได้แคบกว่า CommandPayload
// ด้านล่าง: ไม่มีทางถูกสร้างจาก action ที่ user สั่งเองหรือที่ AI parse มา
// (CommandAction ไม่มี member "self_update" และ action enum ของ LLM parser
// ก็ไม่มีเช่นกัน — ดู llm/schema.ts) มาจาก logic เช็คเวอร์ชันของ ws/server.ts
// เองเท่านั้น
export interface SelfUpdatePayload {
  version: string;
  url: string;
  sha256: string;
  issued_at_unix: number;
  signature: string;
}

// คำสั่งจากเซิร์ฟเวอร์ไปยัง agent ให้แทนที่ agent.yaml ของตัวเอง และถ้า
// enable_run_script ถูกตั้งไว้ ให้แน่ใจว่า
// OPTIFLEET_ENABLE_RUN_SCRIPT=true อยู่ใน environment ของ service แล้ว
// restart ดู ConfigUpdatePayload ใน internal/transport/protocol.go สำหรับ
// เหตุผลเต็มๆ — path ที่แยกออกมาและเชื่อถือได้แคบกว่าเช่นเดียวกับ
// SelfUpdatePayload ด้านบน (ไม่มีทางถูกสร้างจาก action ที่ user สั่งเองหรือ
// ที่ AI parse มา) สร้างจาก config-convergence check ของ ws/server.ts เอง
// เท่านั้น ที่เทียบ config_hash ที่รายงานมาในแต่ละ heartbeat กับ config ที่
// ต้องการใน agentConfig.ts
export interface ConfigUpdatePayload {
  config_yaml: string;
  config_sha256: string;
  enable_run_script: boolean;
  issued_at_unix: number;
  signature: string;
}

export interface DiskInfo {
  mount_point: string;
  used_percent: number;
  free_gb: number;
  total_gb: number;
}

// อุปกรณ์จัดเก็บข้อมูลทางกายภาพหนึ่งตัว — เป็น spec inventory (มีไดรฟ์อะไรบ้าง
// เป็น SSD หรือ HDD ขนาดเท่าไหร่) แยกจาก usage ต่อ mount point ของ DiskInfo
// ดู PhysicalDiskInfo ใน internal/telemetry/types.go ว่าทำไมถึงไม่รวมเข้ากับ
// DiskInfo โดยตรง media_type คือ "SSD", "HDD" หรือ "Unknown"
export interface PhysicalDiskInfo {
  model: string;
  media_type: string;
  size_gb: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
  // สัญญาณ "(Not Responding)" ที่มีเฉพาะ Windows — ดู hungWindowPIDs ใน
  // Go agent เป็น true เสมอบนแพลตฟอร์มที่ไม่มีการเช็คแบบนี้ของ OS
  responding: boolean;
}

// อุปกรณ์เสริมที่เชื่อมต่ออยู่ตอนนี้หนึ่งตัว — เป็น snapshot ของ "ตอนนี้เสียบ
// อะไรอยู่บ้าง" (DeviceInfo ใน internal/telemetry/types.go) ไม่ใช่ประวัติ
// การเชื่อมต่อ/ถอด
export interface DeviceInfo {
  type: "usb" | "printer" | "monitor";
  name: string;
  detail?: string;
  // มีค่าเฉพาะตอนที่ OS มีข้อมูลระบุตัวตนจริงสำหรับอุปกรณ์ประเภทนั้น (ตอนนี้
  // มีแค่จอมอนิเตอร์ ผ่าน EDID) — ดู collectMonitorsWindows
  serial_number?: string;
  model?: string;
  manufacturer?: string;
}

// การตั้งค่าเต็มรูปแบบของ network adapter หนึ่งตัว — รายละเอียดระดับเดียวกับ
// ที่ "ipconfig /all" ของ Windows แสดง แยกจาก ip_addresses ธรรมดาของ
// TelemetrySnapshot เอง (ซึ่งมีมาก่อนและยังอยู่สำหรับ case ง่ายๆ "เครื่องนี้
// IP อะไร") field DHCP/gateway/DNS/lease เป็นของ Windows เท่านั้น (ผ่าน
// Win32_NetworkAdapterConfiguration) และจะว่างเปล่าบนแพลตฟอร์มอื่น
export interface NetworkInterface {
  name: string;
  description?: string;
  mac_address?: string;
  ip_addresses: string[];
  subnet_masks?: string[];
  dhcp_enabled: boolean;
  dhcp_server?: string;
  default_gateway?: string[];
  dns_servers?: string[];
  lease_obtained?: string;
  lease_expires?: string;
}

// บัญชี OS user แบบ local (ไม่ใช่ domain) หนึ่งบัญชี — ข้อมูลเดียวกับที่
// "net user" แสดง (LocalUserInfo ใน internal/telemetry/types.go) บวกกับว่า
// บัญชีนั้นอยู่ในกลุ่ม Administrators ที่มีมาให้ในตัวหรือไม่ เฉพาะ Windows
// เท่านั้นตอนนี้ แพลตฟอร์มอื่นรายงาน array ว่างเปล่า
export interface LocalUserInfo {
  username: string;
  full_name?: string;
  is_admin: boolean;
  disabled: boolean;
}

export interface TelemetrySnapshot {
  timestamp: string;
  mode: "normal" | "alert";
  cpu_percent: number;
  mem_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: DiskInfo[];
  physical_disks: PhysicalDiskInfo[];
  top_processes: ProcessInfo[];
  connected_devices: DeviceInfo[];
  hostname: string;
  ip_addresses: string[];
  // Address ที่หันหน้าออกอินเทอร์เน็ตจริงของ agent จากการ lookup ภายนอกของ
  // ตัวเอง — ดู internal/telemetry/publicip.go แยกจาก ip_addresses (address
  // ฝั่ง LAN interface) และแยกจาก address ที่ WebSocket connection ของ agent
  // นี้ดูเหมือนจะมาจาก (registry.ts's remoteIp) ซึ่งจะเป็นค่าเดียวกันก็ต่อเมื่อ
  // เซิร์ฟเวอร์นี้เองอยู่บนอินเทอร์เน็ต ไม่ใช่อยู่ LAN เดียวกับ agent ว่างเปล่า
  // จนกว่า background refresh ของ agent จะเสร็จ
  public_ip: string;
  network_interfaces: NetworkInterface[];
  os: string;
  os_version: string;
  uptime_seconds: number;
  serial_number: string;
  model: string;
  manufacturer: string;
  cpu_model: string;
  local_users: LocalUserInfo[];
  // ใครกำลัง login เข้า interactive console session อยู่ตอนนี้ — แยกจาก
  // local_users ที่บอกแค่ "มีบัญชีอะไรอยู่บ้าง" ว่างเปล่าแปลว่าไม่มีใคร login
  // อยู่ตอนนี้ (หรือแพลตฟอร์มนี้ยังไม่รองรับการเก็บข้อมูลนี้) — ดู doc
  // comment ของ CurrentUser ใน internal/telemetry/types.go
  current_user: string;
}

export interface TelemetryPayload {
  snapshot: TelemetrySnapshot;
}

export type CommandAction = "kill_process" | "clean_temp" | "restart_host" | "shutdown_host" | "run_script" | "network_diagnostic";

// CommandPayload คือสิ่งที่เซิร์ฟเวอร์ส่งไปยัง agent `signature` คำนวณโดย
// commandSigner.ts จากรูปแบบ canonical เดียวกันที่เข้ารหัสด้วย netstring
// ซึ่ง Go agent คำนวณซ้ำตอนรับ (transport.CommandPayload.CanonicalString) —
// ดู crypto/commandSigner.ts ว่าทำไมถึงใช้ netstring แทน JSON
export interface CommandPayload {
  id: string;
  action: CommandAction;
  params: Record<string, string>;
  issued_at_unix: number;
  signature: string;
}

export interface CommandResultPayload {
  command_id: string;
  success: boolean;
  message: string;
  executed_unix: number;
}

// ผลลัพธ์ทีละส่วน (ปกติคือบรรทัดเดียว) ของคำสั่ง network_diagnostic ที่รันนาน
// ขณะที่ผลิตออกมาฝั่ง agent — ดู CommandOutputPayload ใน
// internal/transport/protocol.go ซึ่งไฟล์นี้ mirror ตาม Done=true คือส่วน
// สุดท้าย Error เก็บ failure ที่เกิดขึ้นระหว่างทาง
export interface CommandOutputPayload {
  command_id: string;
  line: string;
  done: boolean;
  error?: string;
}

export interface AlertPayload {
  kind: string;
  message: string;
  fields?: Record<string, string>;
  timestamp_unix: number;
}
