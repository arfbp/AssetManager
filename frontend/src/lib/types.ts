// สะท้อนโครงสร้างจาก server/src/protocol.ts และ shape ของ AgentSummary/
// HistoryEntry ใน server/src/ws/registry.ts กับ
// server/src/history/commandHistory.ts ต้องคอยแก้ให้ตรงกันด้วยมือ เหมือนกับที่
// server เองก็ต้องคอยแก้ให้ตรงกับ Go agent — ไม่มี schema generator ที่ใช้ร่วมกัน
// ทั้งสามโค้ดเบส

export type AgentStatus = "online" | "offline";

// server/src/auth/roles.ts — 'admin' จัดการผู้ใช้ได้ด้วย; 'it_support' สั่ง
// command/จัดการ asset ได้แต่จัดการบัญชีผู้ใช้ไม่ได้; 'viewer' อ่านอย่างเดียวทุกที่
// บังคับใช้จริงฝั่ง server (requireRole ใน auth/roles.ts) — การ gate ตาม role
// ฝั่ง frontend เป็นแค่ความสะดวกด้าน UX ที่เสริมเข้ามา ไม่ใช่ขอบเขตความปลอดภัยจริง
export type Role = "admin" | "it_support" | "viewer";

export interface UserSummary {
  id: string;
  username: string;
  role: Role;
  status: string;
  createdAt: string;
  // ฟิลด์โปรไฟล์พื้นฐาน แยกจาก login identifier (username) — เป็น null สำหรับ
  // บัญชีที่สร้างก่อนที่ฟิลด์เหล่านี้จะมี
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface DiskInfo {
  mount_point: string;
  used_percent: number;
  free_gb: number;
  total_gb: number;
}

// อุปกรณ์จัดเก็บข้อมูลจริงหนึ่งตัว — เป็นข้อมูล spec (มีไดรฟ์อะไรบ้าง, SSD หรือ
// HDD, ขนาดเท่าไร) แยกจากตัวเลขการใช้งานต่อ mount point ของ DiskInfo ด้านบน
// media_type เป็น "SSD", "HDD" หรือ "Unknown" — ค่าสุดท้ายหมายถึง OS ไม่ได้
// รายงานคำตอบที่เชื่อถือได้ทั้งสองทาง ไม่ใช่ว่าการตรวจจับล้มเหลว
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
  // สัญญาณ "(Not Responding)" ที่มีเฉพาะบน Windows — เป็น true เสมอบนแพลตฟอร์ม
  // ที่ไม่มีการเช็คแบบเดียวกันของ OS
  responding: boolean;
}

// อุปกรณ์ peripheral ที่เชื่อมต่ออยู่ตอนนี้หนึ่งชิ้น — เป็น snapshot ของ "ตอนนี้เสียบ
// อะไรอยู่บ้าง" ไม่ใช่ประวัติการเชื่อมต่อ/ถอด
export interface DeviceInfo {
  type: "usb" | "printer" | "monitor";
  name: string;
  detail?: string;
  // ใส่ค่าให้เฉพาะตอนที่ OS มีข้อมูลระบุตัวตนจริงสำหรับอุปกรณ์ประเภทนั้น
  // (ปัจจุบันคือจอมอนิเตอร์ ผ่าน EDID)
  serial_number?: string;
  model?: string;
  manufacturer?: string;
}

// ระดับรายละเอียดเทียบเท่ากับที่ "ipconfig /all" ของ Windows แสดงต่อ adapter
// หนึ่งตัว — ฟิลด์ DHCP/gateway/DNS/lease มีเฉพาะบน Windows ส่วนแพลตฟอร์มอื่นจะ
// เป็นค่าว่าง
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

// บัญชีผู้ใช้ OS แบบ local (ไม่ใช่ domain) หนึ่งบัญชี — ข้อมูลเดียวกับที่ "net user"
// แสดง บวกกับว่าบัญชีนั้นอยู่ในกลุ่ม Administrators ในตัวหรือไม่ ปัจจุบันมีเฉพาะ
// Windows; แพลตฟอร์มอื่นจะรายงานเป็น array ว่าง
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
  // ใครกำลัง login เข้า interactive console session อยู่ตอนนี้ — คนละเรื่องกับ
  // "มีบัญชีอะไรอยู่บ้างทั้งหมด" ของ local_users ค่าว่างหมายถึงไม่มีใคร login อยู่
  // ตอนนี้ (หรือแพลตฟอร์มนี้ยังไม่เก็บข้อมูลนี้)
  current_user: string;
}

export interface AgentSummary {
  agentId: string;
  status: AgentStatus;
  connectedAt: number;
  lastSeenAt: number;
  lastTelemetry: TelemetrySnapshot | null;
}

export type CommandAction = "kill_process" | "clean_temp" | "restart_host" | "shutdown_host" | "run_script" | "network_diagnostic";

// ผลลัพธ์ของ command network_diagnostic ที่กำลังรันอยู่ ส่งมาทีละส่วนย่อย
// (ปกติทีละบรรทัด) ตามที่ agent ผลิตออกมาจริง — เช่นแต่ละ hop ของ tracert,
// การตอบกลับของ ping, แต่ละแถวของ netstat — ไม่ใช่แค่ผลลัพธ์สุดท้ายเพียงอย่างเดียว
// done=true คือ chunk สุดท้ายของ commandId นั้น (line อาจว่างในตัวนั้นก็ได้)
export interface CommandOutputPayload {
  command_id: string;
  line: string;
  done: boolean;
  error?: string;
}

export type HistoryEntryStatus = "dispatched" | "offline" | "succeeded" | "failed";

export interface HistoryEntry {
  commandId: string;
  agentId: string;
  action: CommandAction;
  params: Record<string, string>;
  requestedBy: string;
  sourceText: string | null;
  status: HistoryEntryStatus;
  message: string | null;
  dispatchedAt: number;
  resolvedAt: number | null;
}

export interface ResolvedCommand {
  action: CommandAction;
  params: Record<string, string>;
}

export type CommandApiResponse =
  | { status: "dispatched"; resolved: ResolvedCommand; results: { agentId: string; dispatched: boolean; commandId: string }[]; reasoning?: string }
  | { status: "needs_confirmation"; pendingId: string; reason: string; resolved: ResolvedCommand; targets: string[]; expiresInSeconds: number; reasoning?: string }
  // คำตอบแบบ read-only ของ query_info — ไม่มีอะไรถูก dispatch ไปยังอุปกรณ์ใด
  // fallback=true หมายถึง request นี้ไม่ตรงกับ action ที่รองรับเจาะจงตัวไหนเลย
  // เป็นกรณีที่ server fallback ไปตอบว่า "นี่คือสถานะปัจจุบันจริงของอุปกรณ์"
  // แทนที่จะปฏิเสธไปเฉย ๆ
  | { status: "answered"; agentId: string; answerable: boolean; answer: string; reasoning?: string; fallback?: boolean }
  // คำตอบสำหรับการจัดการองค์กร/ผู้ใช้ — ดู
  // server/src/security/adminGuardrail.ts "admin_form" หมายถึงยังไม่มีอะไร
  // เกิดขึ้นจริง: ฝั่งเรียกจะเปิด modal ของ dashboard ตามชื่อที่ระบุ พร้อม
  // pre-fill ด้วย `prefill` แล้วให้ operator กรอกต่อ/submit เองตามปกติ
  | { status: "admin_form"; formAction: "create_organization" | "create_user"; prefill: Record<string, string>; reasoning?: string }
  // kind: "admin" ใช้แยกจาก variant needs_confirmation ของอุปกรณ์ด้านบน
  // (ซึ่งจะมี `targets` เสมอ) — ตอน confirm ทั้งสองแบบยิงไปที่ endpoint
  // POST /command/:id/confirm เดียวกัน
  | {
      status: "needs_confirmation";
      kind: "admin";
      pendingId: string;
      reason: string;
      resolved: { action: string; orgName?: string; username?: string };
      expiresInSeconds: number;
      reasoning?: string;
    }
  // คำตอบของ Asset Management ERP — ดู server/src/security/erpGuardrail.ts
  // shape เดียวกับ "admin_form หมายถึงยังไม่มีอะไรเกิดขึ้นจริง" เหมือน variant
  // ขององค์กร/ผู้ใช้ด้านบน
  | { status: "erp_form"; formAction: "create_vendor" | "create_purchase_order"; prefill: Record<string, string>; reasoning?: string }
  | {
      status: "needs_confirmation";
      kind: "erp";
      pendingId: string;
      reason: string;
      resolved: { action: string; poNumber?: string; assetTag?: string };
      expiresInSeconds: number;
      reasoning?: string;
    }
  // คำตอบทันที (ไม่ต้อง confirm) สำหรับ generate_installer
  | {
      status: "admin_result";
      resultAction: "generate_installer";
      installerOrgId: string;
      orgName: string;
      subdomain: string;
      ownOrg: boolean;
      reasoning?: string;
    }
  // ผลลัพธ์ของ POST /command/:id/confirm สำหรับ admin action ที่ confirm แล้ว
  // (suspend/reactivate/delete บนองค์กรหรือผู้ใช้)
  | { status: "admin_result"; message: string };

export interface ApiErrorBody {
  error: string;
  parsed?: unknown;
}

export interface RemediationSuggestion {
  suggested_action: "kill_process" | "monitor";
  reasoning: string;
  risk_note: string;
}

// จุดข้อมูลหนึ่งจุดของกราฟแนวโน้ม CPU/RAM/Disk — จาก
// server/src/api/routes.ts's GET /agents/:id/history ดึงมาจากตาราง
// telemetry_snapshots ที่เก็บถาวร ไม่ใช่ state "ล่าสุดที่รู้" ที่อยู่ใน memory
// ของ AgentRegistry
export interface HistoryPoint {
  recordedAt: string;
  cpuPercent: number;
  memPercent: number;
  disks: DiskInfo[];
}

// เหตุการณ์หนึ่งครั้งจาก incident log ของอุปกรณ์ — ปัจจุบันมีแค่ "process
// หยุดตอบสนอง" (kind: "process_not_responding") ยัง open อยู่ (resolvedAt
// เป็น null) ตราบใดที่ยังไม่จบ
export interface Incident {
  id: number;
  agentId: string;
  kind: string;
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
}

// server/src/api/routes.ts's GET /fleet/locations — ตำแหน่ง *โดยประมาณ* ของ
// agent ผ่าน IP geolocation (ดู server/src/geolocation/ipGeo.ts) ไม่ใช่ GPS
// จริง — ระบบนี้ไม่มีฮาร์ดแวร์ระบุตำแหน่งอยู่เลย isPrivate เป็น true หมายถึง
// remoteIp เป็น LAN/private address ซึ่งโดยหลักการแล้วไม่มีอะไรให้ lookup
// (ส่วนใหญ่คืออุปกรณ์ในออฟฟิศเดียวกัน); isPrivate เป็น false แต่ lat/lon ยัง
// เป็น null หมายถึง public IP ที่ lookup แล้วหาไม่เจอ
export interface DeviceLocationEntry {
  agentId: string;
  status: AgentStatus;
  remoteIp: string | null;
  isPrivate: boolean | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  isp: string | null;
  asn: string | null;
  zip: string | null;
  timezone: string | null;
}

// server/src/api/routes.ts's GET /fleet/incident-summary — จำนวน incident
// ธรรมดาต่ออุปกรณ์ในช่วงเวลาหนึ่ง ใช้สำหรับจัดอันดับ "อุปกรณ์ที่มีปัญหามากที่สุด"
// บน Dashboard ไม่มี LLM มาเกี่ยวข้อง (ต่างจาก DeviceAnalysis ซึ่งเป็น call
// แบบ on-demand ต่ออุปกรณ์) — อุปกรณ์ที่ไม่มี incident เลยในช่วงเวลานั้นจะไม่
// ปรากฏใน list นี้เลย ไม่ได้ถูกส่งกลับมาเป็นแถวที่มีค่า 0
export interface IncidentSummaryEntry {
  agentId: string;
  incidentCount: number;
  lastIncidentAt: string;
}

// server/src/api/routes.ts's GET /agents/:id/report — สรุปการใช้ resource/
// ความเสถียรในช่วงเวลาล่าสุด คำนวณจาก telemetry_snapshots + device_incidents
// ที่เก็บถาวร ไม่ใช่ state "ล่าสุดที่รู้" ใน memory
export interface DeviceReport {
  deviceId: string;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  uptimeSeconds: number;
  windowDays: number;
  avgCpuPercent: number;
  maxCpuPercent: number;
  avgMemPercent: number;
  maxMemPercent: number;
  worstDiskUsedPercent: number | null;
  incidentCount: number;
  sampleCount: number;
}

export interface DeviceAnalysis {
  verdict: "recommend_replacement" | "monitor" | "no_action_needed";
  reasoning: string;
  note: string;
}

// เหตุการณ์หนึ่งครั้งของ peripheral asset ที่เชื่อมต่อผ่านคอมพิวเตอร์เครื่องหนึ่ง —
// server/src/assets/connectionHistoryStore.ts disconnectedAt เป็น null
// สำหรับเหตุการณ์ที่ยัง open อยู่ (ตำแหน่งปัจจุบันของ peripheral หรือตำแหน่ง
// ล่าสุดที่รู้ถ้าหยุดรายงานไปแล้ว)
export interface ConnectionHistoryEntry {
  agentId: string;
  connectedAt: string;
  disconnectedAt: string | null;
}

// ทะเบียนทรัพย์สิน — ฟิลด์ inventory/จัดซื้อที่ operator กรอกเอง
// (server/src/assets/assetsStore.ts) join แบบ read-only เข้ากับสิ่งที่อุปกรณ์
// ที่เชื่อมโยงไว้รายงานอัตโนมัติอยู่แล้ว (serialNumber/model/manufacturer/
// liveStatus มาจาก telemetry snapshot ล่าสุด ไม่ได้เก็บไว้ในตาราง assets เอง)
export type AssetStatus = "ready_to_deploy" | "deployed" | "in_repair" | "retired";

// asset ประเภท "computer" จะเชื่อมกับ agent_id และแสดงข้อมูล telemetry
// สด ๆ เสมอ ส่วน asset ประเภท "peripheral" (เช่นจอมอนิเตอร์) ไม่มีการเชื่อมต่อ
// telemetry ของตัวเอง — manufacturer/model/serial จะถูกบันทึกครั้งเดียวตอน
// ลงทะเบียน ปกติจะ pre-fill มาจาก connected_devices list ของคอมพิวเตอร์แม่
// (ดู DeviceInfo)
export type AssetType = "computer" | "peripheral";

export interface AssetInput {
  agentId?: string | null;
  status?: AssetStatus;
  category?: string | null;
  location?: string | null;
  orderNumber?: string | null;
  checkedOutTo?: string | null;
  checkedOutToEmail?: string | null;
  checkedOutToDepartment?: string | null;
  checkoutDate?: string | null;
  expectedCheckinDate?: string | null;
  eolDate?: string | null;
  notes?: string | null;
  // กรอกเอง เพื่อให้ลงทะเบียน asset ล่วงหน้าได้ (พร้อม serial ที่รู้อยู่แล้ว) ก่อนที่
  // อุปกรณ์จะเชื่อมต่อจริง — server/src/db/persistence.ts จะเชื่อม agent ที่เพิ่ง
  // ต่อเข้ามาใหม่กับ row นี้เมื่อ serial ที่รายงานสดตรงกัน แทนที่จะสร้าง asset
  // ซ้ำ สำหรับ asset ประเภท "peripheral" ค่านี้คือ serial จริงตรง ๆ เพราะไม่มี
  // telemetry สดให้เลือกใช้แทน
  manualSerialNumber?: string | null;
  assetType?: AssetType;
  manufacturer?: string | null;
  model?: string | null;
  // peripheral ตัวนี้เชื่อมต่อผ่านคอมพิวเตอร์เครื่องไหนตอนลงทะเบียน — ใช้เป็น
  // ข้อมูลอ้างอิงเท่านั้น ไม่ได้ sync ตามหลังจากนั้น
  parentAgentId?: string | null;
  // การคำนวณค่าเสื่อมราคา/การเงิน — ดู server/src/assets/depreciation.ts
  // กรอกเองทั้งหมด; purchaseCost/purchaseDate/depreciationYears ต้องมีค่า
  // ครบทั้งสามตัวถึงจะคำนวณ currentBookValue ด้านล่างได้
  purchaseCost?: number | null;
  purchaseDate?: string | null;
  depreciationYears?: number | null;
  salvageValue?: number | null;
  warrantyExpiryDate?: string | null;
  // สร้างมาจาก asset_models row ไหน (ถ้ามี) — ดู AssetModel ด้านล่าง ใช้เป็น
  // ข้อมูลอ้างอิงเท่านั้น ไม่เคย sync ตามหลังจากนั้น
  assetModelId?: string | null;
  // ที่มาการจัดซื้อแบบมีโครงสร้าง ถูกตั้งค่าอัตโนมัติโดย flow การรับของจาก PO;
  // vendorId ยังแก้ไขเองได้ใน AssetFormModal ด้วย
  vendorId?: string | null;
  purchaseOrderId?: string | null;
  // ลิงก์แบบมีโครงสร้างไปยังทะเบียนพนักงาน (migrations/0030) เป็น null สำหรับ
  // อะไรก็ตามที่เบิกไปก่อนที่ทะเบียนนี้จะมี หรือเบิกให้คนที่ตั้งใจไม่ใส่ในทะเบียน —
  // ในกรณีนั้น checkedOutTo/Email/Department ด้านบนยังเป็น snapshot ที่ถูกต้อง
  // ณ ช่วงเวลานั้น
  checkedOutToEmployeeId?: string | null;
  // ช่องข้อมูลกำหนดเองที่ตั้งชื่อได้ 5 ช่อง — ดู CustomFieldLabels ด้านล่าง จะ
  // แสดงใน UI เฉพาะช่องที่องค์กรตั้งชื่อไว้เท่านั้น
  customField1?: string | null;
  customField2?: string | null;
  customField3?: string | null;
  customField4?: string | null;
  customField5?: string | null;
  // asset นี้ขอเบิกผ่าน flow AssetRequest แบบ self-service ได้หรือไม่
  isRequestable?: boolean;
}

export interface AssetWithLiveInfo extends AssetInput {
  assetTag: string;
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  // คำนวณแบบ straight-line สด ๆ โดย server ทุกครั้งที่อ่าน — ไม่เคยถูกเก็บไว้
  // และไม่มีทางเป็นค่าเก่าค้าง เป็น null เว้นแต่ purchaseCost/purchaseDate/
  // depreciationYears จะมีค่าครบทั้งหมด
  currentBookValue: number | null;
  liveStatus: AgentStatus | null;
  serialNumber: string | null;
  model: string | null;
  manufacturer: string | null;
  ipAddresses: string[] | null;
  // มาจาก telemetry snapshot ล่าสุดของ agent ที่เชื่อมโยงไว้ตรง ๆ ทั้งคู่
  // เหมือนกับ serialNumber/model/manufacturer ด้านบน — เป็น null สำหรับ asset
  // ประเภท "peripheral" หรือถ้าคอมพิวเตอร์ที่เชื่อมโยงไว้ยังไม่เคยรายงาน snapshot
  cpuModel: string | null;
  physicalDisks: PhysicalDiskInfo[] | null;
  // เหตุการณ์ asset_connection_history ล่าสุดของ asset ประเภท "peripheral" —
  // เป็น null ทั้งหมดถ้าไม่เคยถูกติดตามว่าเชื่อมต่อกับอะไรเลย
  // lastConnectionDisconnectedAt เป็น null หมายถึงเหตุการณ์นั้นยัง open อยู่
  // (คือตำแหน่งที่มันเชื่อมต่ออยู่ตอนนี้)
  lastConnectionAgentId: string | null;
  lastConnectedAt: string | null;
  lastConnectionDisconnectedAt: string | null;
  // สรุปข้อมูลข้ามโมดูล คำนวณฝั่ง server ทุกครั้งที่อ่าน (ดู AssetErpSummary ใน
  // server/src/assets/assetsStore.ts) ตัวเลขทั้งสามค่าเป็นตัวเลขเสมอ ไม่มีทาง
  // เป็น null — render ได้ตรง ๆ เลย
  vendorName: string | null;
  purchaseOrderNumber: string | null;
  assetModelName: string | null;
  checkedOutToEmployeeName: string | null;
  nextMaintenanceDate: string | null;
  openMaintenanceCount: number;
  licenseCount: number;
  pendingRequestCount: number;
}

// --- Asset Management ERP (server/src/vendors, การจัดซื้อ, งานซ่อมบำรุง, การส่งมอบ) ---

export interface Vendor {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  legalName: string | null;
  taxId: string | null;
  paymentTerms: string | null;
  bankAccountInfo: string | null;
  category: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VendorInput = Partial<Omit<Vendor, "id" | "createdAt" | "updatedAt">>;

export interface Department {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  // เป็นตัวเลขเสมอ ไม่มีทางเป็น null — ดู DepartmentRecord ใน
  // server/src/departments/departmentsStore.ts
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}
export type DepartmentInput = Partial<Omit<Department, "id" | "employeeCount" | "createdAt" | "updatedAt">>;

export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  // join สด ๆ ทุกครั้งที่อ่าน — ดู EmployeeRecord ใน
  // server/src/employees/employeesStore.ts
  departmentName: string | null;
  userId: string | null;
  username: string | null;
  status: EmployeeStatus;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  // เป็นตัวเลขเสมอ ไม่มีทางเป็น null — render ได้ตรง ๆ
  assetCount: number;
  handoverCount: number;
  createdAt: string;
  updatedAt: string;
}
export type EmployeeInput = Partial<Omit<Employee, "id" | "departmentName" | "username" | "assetCount" | "handoverCount" | "createdAt" | "updatedAt">>;

export type EmployeeHistoryEventKind = "handover_out" | "handover_returned" | "request_created" | "request_approved" | "request_rejected" | "request_cancelled";
export interface EmployeeHistoryEvent {
  kind: EmployeeHistoryEventKind;
  at: string;
  summary: string;
  assetTag: string;
}

export interface PurchaseOrderItem {
  id: string;
  description: string;
  quantity: number;
  unitCost: number;
  assetCategory: string | null;
}

export type PurchaseOrderStatus = "draft" | "pending_approval" | "approved" | "rejected" | "received" | "cancelled";

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  status: PurchaseOrderStatus;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  items: PurchaseOrderItem[];
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewPurchaseOrderItemInput {
  description: string;
  quantity: number;
  unitCost: number;
  assetCategory?: string | null;
}

export interface NewPurchaseOrderInput {
  vendorId: string;
  orderDate?: string | null;
  expectedDeliveryDate?: string | null;
  notes?: string | null;
  items: NewPurchaseOrderItemInput[];
}

export type MaintenanceType = "scheduled" | "repair" | "inspection";
export type MaintenanceStatus = "scheduled" | "completed" | "cancelled";

export interface MaintenanceRecord {
  id: string;
  assetTag: string;
  type: MaintenanceType;
  description: string;
  scheduledDate: string | null;
  completedDate: string | null;
  status: MaintenanceStatus;
  cost: number | null;
  performedBy: string | null;
  notes: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MaintenanceInput = Partial<Omit<MaintenanceRecord, "id" | "overdue" | "createdAt" | "updatedAt">>;

export type HandoverStatus = "pending_signature" | "acknowledged";

export interface Handover {
  id: string;
  assetTag: string;
  // ลิงก์แบบมีโครงสร้างไปยังทะเบียนพนักงาน (migrations/0030) เป็น null สำหรับ
  // handover ที่สร้างก่อนทะเบียนนี้จะมี หรือกรณีที่พิมพ์ชื่อที่ไม่อยู่ในทะเบียน —
  // employeeName ด้านล่างเป็น snapshot ที่ถูกต้องเสมอ
  employeeId: string | null;
  employeeName: string;
  employeeEmail: string | null;
  employeeDepartment: string | null;
  handoverDate: string;
  conditionNotes: string | null;
  status: HandoverStatus;
  issuedBy: string;
  returnedAt: string | null;
  employeeSignature: string | null;
  eulaAcceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandoverInput {
  assetTag: string;
  // เลือกพนักงานจากทะเบียน หรือพิมพ์ชื่อเองก็ได้ — server ต้องการอย่างน้อยหนึ่งใน
  // employeeId/employeeName
  employeeId?: string | null;
  employeeName?: string;
  employeeEmail?: string | null;
  employeeDepartment?: string | null;
  handoverDate?: string;
  conditionNotes?: string | null;
}

export interface AcknowledgeHandoverInput {
  employeeSignature?: string | null;
  eulaAccepted?: boolean;
}

// --- Asset Management เฟส 2: รุ่นทรัพย์สิน, ฟิลด์กำหนดเอง, คำขอเบิก, ใบอนุญาต, ประวัติ ---

export interface AssetModel {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  depreciationYears: number | null;
  salvageValue: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AssetModelInput = Partial<Omit<AssetModel, "id" | "createdAt" | "updatedAt">>;

export interface CustomFieldLabels {
  field1Label: string | null;
  field2Label: string | null;
  field3Label: string | null;
  field4Label: string | null;
  field5Label: string | null;
}

export type AssetRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface AssetRequest {
  id: string;
  assetTag: string;
  requestedBy: string;
  note: string | null;
  status: AssetRequestStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  // ถูกตั้งค่าตอน approve — คนละอย่างกับ requestedBy (username สำหรับ login
  // ของ OptiFleet) ดู approve handler ใน server/src/api/routes.ts
  onBehalfOfEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LicenseAssignment {
  id: string;
  assetTag: string;
  assignedAt: string;
}

export interface SoftwareLicense {
  id: string;
  name: string;
  vendorId: string | null;
  vendorName: string | null;
  licenseKey: string | null;
  seats: number | null;
  purchaseDate: string | null;
  expiryDate: string | null;
  cost: number | null;
  notes: string | null;
  assignments: LicenseAssignment[];
  seatsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export type LicenseInput = Partial<Omit<SoftwareLicense, "id" | "vendorName" | "assignments" | "seatsUsed" | "createdAt" | "updatedAt">>;

export type AssetHistoryEventKind =
  | "handover_out"
  | "handover_returned"
  | "maintenance_scheduled"
  | "maintenance_completed"
  | "connection"
  | "transfer"
  | "adjustment"
  | "retirement";

export interface AssetHistoryEvent {
  kind: AssetHistoryEventKind;
  at: string;
  summary: string;
}

export interface ErpAlerts {
  expiringWarranties: { assetTag: string; warrantyExpiryDate: string }[];
  upcomingMaintenance: MaintenanceRecord[];
  expiringLicenses: { id: string; name: string; expiryDate: string }[];
}

// --- Fixed-Asset Accounting: ผังบัญชี, สมุดรายวัน, รอบบัญชี, รอบคำนวณค่าเสื่อมราคา ---

export type GlAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: GlAccountType;
  isContra: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GlAccountInput = Partial<Omit<GlAccount, "id" | "isSystem" | "createdAt" | "updatedAt">>;

export interface JournalEntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface JournalEntry {
  id: string;
  entryDate: string;
  fiscalYear: number;
  source: string;
  sourceId: string | null;
  description: string;
  status: "posted" | "reversed";
  reversesEntryId: string | null;
  createdBy: string;
  lines: JournalEntryLine[];
  totalDebit: number;
  createdAt: string;
}

export interface FiscalPeriod {
  fiscalYear: number;
  status: "open" | "closed";
  closedAt: string | null;
  closedBy: string | null;
}

export interface DepreciationRunLine {
  id: string;
  assetTag: string;
  amount: number;
  bookValueBefore: number;
  bookValueAfter: number;
}

export interface DepreciationRun {
  id: string;
  fiscalYear: number;
  period: number | null;
  runDate: string;
  status: "draft" | "posted" | "reversed";
  journalEntryId: string | null;
  totalAmount: number;
  createdBy: string;
  lines: DepreciationRunLine[];
  createdAt: string;
}

// --- Asset lifecycle: การโอนย้าย, ตรวจนับจริง, การปรับปรุงรายการ, การตัดจำหน่าย ---

export interface AssetTransfer {
  id: string;
  assetTag: string;
  fromLocation: string | null;
  toLocation: string | null;
  fromDepartment: string | null;
  toDepartment: string | null;
  transferDate: string;
  reason: string | null;
  transferredBy: string;
  createdAt: string;
}

export interface AssetTransferInput {
  assetTag: string;
  toLocation?: string | null;
  fromDepartment?: string | null;
  toDepartment?: string | null;
  transferDate?: string;
  reason?: string | null;
}

export interface AssetCountCycle {
  id: string;
  name: string;
  startedAt: string;
  dueDate: string | null;
  status: "open" | "closed";
  createdBy: string;
  closedAt: string | null;
  totalLines: number;
  countedLines: number;
  discrepancyLines: number;
}

export interface AssetCountLine {
  id: string;
  cycleId: string;
  assetTag: string;
  expectedLocation: string | null;
  counted: boolean;
  countedAt: string | null;
  countedBy: string | null;
  actualLocation: string | null;
  discrepancy: boolean;
  notes: string | null;
}

export type AdjustmentField = "purchase_cost" | "depreciation_years" | "salvage_value" | "warranty_expiry_date" | "other";

export interface AssetAdjustment {
  id: string;
  assetTag: string;
  adjustmentDate: string;
  fieldChanged: AdjustmentField;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  adjustedBy: string;
  journalEntryId: string | null;
  createdAt: string;
}

export interface AssetAdjustmentInput {
  assetTag: string;
  fieldChanged: AdjustmentField;
  newValue: string;
  reason?: string | null;
  adjustmentDate?: string;
}

export type RetirementReason = "disposed" | "sold" | "lost" | "stolen" | "donated" | "other";

export interface AssetRetirement {
  id: string;
  assetTag: string;
  retirementDate: string;
  reason: RetirementReason;
  disposalMethod: string | null;
  proceeds: number | null;
  notes: string | null;
  journalEntryId: string | null;
  retiredBy: string;
  createdAt: string;
}

export interface AssetRetirementInput {
  assetTag: string;
  reason: RetirementReason;
  disposalMethod?: string | null;
  proceeds?: number | null;
  notes?: string | null;
  retirementDate?: string;
}

// ข้อความที่รับผ่าน dashboard WebSocket (server/src/ws/dashboardServer.ts)
export type DashboardWsMessage =
  | { type: "snapshot"; agents: AgentSummary[]; history: HistoryEntry[] }
  | { type: "agent_update"; agent: AgentSummary }
  | { type: "history_entry"; entry: HistoryEntry }
  | { type: "command_output"; agentId: string; output: CommandOutputPayload };
