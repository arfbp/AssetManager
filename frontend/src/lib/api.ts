// REST client สำหรับ OptiFleet Central Server API ทุก call จะส่ง session
// token ปัจจุบันของผู้ใช้ (src/lib/session.ts) — เป็น session จากการ login
// จริง ไม่ใช่ secret ที่ใช้ร่วมกันแบบตายตัว ข้อมูล "ใครเป็นคนทำ" (requestedBy)
// ฝั่ง client ไม่ส่งมาเองอีกต่อไป server เป็นคนอ้างอิงจาก session เอง
// (server/src/api/routes.ts) ดังนั้นต่อให้ client อยากปลอมตัวเป็นคนอื่นก็ทำ
// ไม่ได้
import type {
  ApiErrorBody,
  CommandApiResponse,
  RemediationSuggestion,
  TelemetrySnapshot,
  ProcessInfo,
  HistoryPoint,
  AssetWithLiveInfo,
  AssetInput,
  Incident,
  DeviceReport,
  DeviceAnalysis,
  ConnectionHistoryEntry,
  IncidentSummaryEntry,
  DeviceLocationEntry,
  UserSummary,
  Role,
  Vendor,
  VendorInput,
  Department,
  DepartmentInput,
  Employee,
  EmployeeInput,
  EmployeeHistoryEvent,
  PurchaseOrder,
  NewPurchaseOrderInput,
  MaintenanceRecord,
  MaintenanceInput,
  Handover,
  HandoverInput,
  AcknowledgeHandoverInput,
  ErpAlerts,
  AssetModel,
  AssetModelInput,
  CustomFieldLabels,
  AssetRequest,
  SoftwareLicense,
  LicenseInput,
  AssetHistoryEvent,
  GlAccount,
  GlAccountInput,
  JournalEntry,
  FiscalPeriod,
  DepreciationRun,
  AssetTransfer,
  AssetTransferInput,
  AssetCountCycle,
  AssetCountLine,
  AssetAdjustment,
  AssetAdjustmentInput,
  AssetRetirement,
  AssetRetirementInput,
} from "./types";
import { getToken, notifyUnauthorized } from "./session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ไม่ได้สร้างบน request() ด้านบน — เพราะ request() สมมติว่า body เป็น JSON
// แต่ตัวนี้เป็นไฟล์ binary <a href> ธรรมดาแปะ Authorization header ที่ route นี้
// ต้องการไม่ได้ (GET /api/downloads/agent-installer ถูก gate เหมือน action
// admin/it_support อื่น ๆ ไม่ใช่ไฟล์ public) จึง fetch ตัว blob เองแล้วสร้าง
// object URL แบบใช้ครั้งเดียวให้ browser เซฟไฟล์ — เทคนิคเดียวกับที่
// ImportAssetsModal ใช้กับ CSV template ของมัน แค่ดึงจาก server แทนที่จะสร้าง
// ฝั่ง client เอง
export async function downloadAgentInstaller(): Promise<void> {
  const res = await fetch(`${API_URL}/api/downloads/agent-installer`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `download failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "OptiFleet-Agent-Global-Deploy.zip";
  a.click();
  URL.revokeObjectURL(url);
}

export function submitCommand(text: string, scope?: string): Promise<CommandApiResponse> {
  return request<CommandApiResponse>("/api/command", {
    method: "POST",
    body: JSON.stringify(scope ? { text, scope } : { text }),
  });
}

export function confirmCommand(pendingId: string): Promise<CommandApiResponse> {
  return request<CommandApiResponse>(`/api/command/${encodeURIComponent(pendingId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function killProcess(
  agentId: string,
  target: { pid?: number; name?: string },
): Promise<{ status: string; results: { agentId: string; dispatched: boolean; commandId: string }[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/kill-process`, {
    method: "POST",
    body: JSON.stringify(target),
  });
}

// เส้นทาง dispatch แบบ run_script โดยตรงเส้นเดียว — ดู doc comment ของ
// POST /agents/:id/run-script ใน server/src/api/routes.ts เฉพาะ admin
// เท่านั้น และจะ 403 ทันทีถ้า server ยังไม่ได้เปิดใช้ run_script dispatch เลย
// (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH) หรือถ้า config local ของ agent
// ปลายทางยังไม่ converge มาอนุญาตให้ทำ (ดู internal/configpush)
export function runScript(
  agentId: string,
  script: string,
): Promise<{ status: string; results: { agentId: string; dispatched: boolean; commandId: string }[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/run-script`, {
    method: "POST",
    body: JSON.stringify({ script }),
  });
}

export interface UploadedInstaller {
  id: string;
  filename: string;
  bytes: number;
  downloadUrl: string;
  agentAuthToken: string;
}

// ไม่ได้สร้างบน request() — เหตุผลเดียวกับ downloadAgentInstaller คือ body
// เป็น binary ไม่ใช่ JSON filename ถูกส่งเป็น query param เพราะ body เองคือ
// byte ดิบของไฟล์ล้วน ๆ ไม่มีอย่างอื่นปน
export async function uploadInstaller(file: File): Promise<UploadedInstaller> {
  const res = await fetch(`${API_URL}/api/software-uploads?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `upload failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export interface AgentBuildSummary {
  version: string;
  sha256: string;
  filename: string;
  uploadedAt: string;
}

export interface AgentUpdateStatus {
  agentId: string;
  status: "online" | "offline";
  version: string | null;
  updateStatus: "up_to_date" | "pending" | "unknown";
}

export interface AgentBuildsOverview {
  activeVersion: string | null;
  builds: AgentBuildSummary[];
  agents: AgentUpdateStatus[];
}

export function getAgentBuilds(): Promise<AgentBuildsOverview> {
  return request("/api/agent-builds");
}

// รูปแบบ upload แบบ raw-body เดียวกับ uploadInstaller — ไฟล์ .exe ของ agent
// ขนาดหลาย MB ไม่ใช่ JSON version ถูกส่งเป็น query param คู่กับ byte ดิบ
export async function uploadAgentBuild(file: File, version: string): Promise<{ build: AgentBuildSummary }> {
  const res = await fetch(`${API_URL}/api/agent-builds?version=${encodeURIComponent(version)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `upload failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export function activateAgentBuild(version: string): Promise<{ activeVersion: string }> {
  return request(`/api/agent-builds/${encodeURIComponent(version)}/activate`, { method: "POST" });
}

export function suggestRemediation(
  agentId: string,
  pid: number,
): Promise<{ suggestion: RemediationSuggestion; process: ProcessInfo }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/suggest-remediation`, {
    method: "POST",
    body: JSON.stringify({ pid }),
  });
}

export function getTelemetry(agentId: string): Promise<{ snapshot: TelemetrySnapshot }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/telemetry`);
}

export function getHistory(agentId: string, hours = 6): Promise<{ points: HistoryPoint[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/history?hours=${encodeURIComponent(hours)}`);
}

export function getIncidents(agentId: string): Promise<{ incidents: Incident[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/incidents`);
}

export function getDeviceReport(agentId: string, days = 7): Promise<{ report: DeviceReport; analysis: DeviceAnalysis }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/report?days=${encodeURIComponent(days)}`);
}

export function getFleetIncidentSummary(days = 30, limit = 10): Promise<{ days: number; devices: IncidentSummaryEntry[] }> {
  return request(`/api/fleet/incident-summary?days=${encodeURIComponent(days)}&limit=${encodeURIComponent(limit)}`);
}

export function getFleetLocations(): Promise<{ devices: DeviceLocationEntry[] }> {
  return request("/api/fleet/locations");
}

export function getAssets(): Promise<{ assets: AssetWithLiveInfo[]; unregisteredAgents: string[] }> {
  return request("/api/assets");
}

export function createAsset(input: AssetInput & { assetTag?: string }): Promise<{ asset: AssetWithLiveInfo }> {
  return request("/api/assets", { method: "POST", body: JSON.stringify(input) });
}

export function updateAsset(assetTag: string, input: Partial<AssetInput>): Promise<{ asset: AssetWithLiveInfo }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}`, { method: "PUT", body: JSON.stringify(input) });
}

export interface ImportAssetsResult {
  index: number;
  assetTag: string;
  action: "created" | "updated" | "failed";
  error?: string;
}

export function importAssets(
  rows: (AssetInput & { assetTag?: string })[],
): Promise<{ results: ImportAssetsResult[]; summary: { created: number; updated: number; failed: number } }> {
  return request("/api/assets/import", { method: "POST", body: JSON.stringify({ rows }) });
}

export function deleteAsset(assetTag: string): Promise<void> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}`, { method: "DELETE" });
}

export function getConnectionHistory(assetTag: string): Promise<{ entries: ConnectionHistoryEntry[] }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}/connection-history`);
}

// --- Asset Management ERP: ผู้จำหน่าย, ใบสั่งซื้อ, งานซ่อมบำรุง, การส่งมอบ ---

export function getVendors(): Promise<{ vendors: Vendor[] }> {
  return request("/api/vendors");
}

export function createVendor(input: VendorInput): Promise<{ vendor: Vendor }> {
  return request("/api/vendors", { method: "POST", body: JSON.stringify(input) });
}

export function updateVendor(id: string, input: VendorInput): Promise<{ vendor: Vendor }> {
  return request(`/api/vendors/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteVendor(id: string): Promise<void> {
  return request(`/api/vendors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getDepartments(): Promise<{ departments: Department[] }> {
  return request("/api/departments");
}

export function createDepartment(input: DepartmentInput): Promise<{ department: Department }> {
  return request("/api/departments", { method: "POST", body: JSON.stringify(input) });
}

export function updateDepartment(id: string, input: DepartmentInput): Promise<{ department: Department }> {
  return request(`/api/departments/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteDepartment(id: string): Promise<void> {
  return request(`/api/departments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getEmployees(): Promise<{ employees: Employee[] }> {
  return request("/api/employees");
}

export function getEmployee(id: string): Promise<{ employee: Employee }> {
  return request(`/api/employees/${encodeURIComponent(id)}`);
}

export function createEmployee(input: EmployeeInput): Promise<{ employee: Employee }> {
  return request("/api/employees", { method: "POST", body: JSON.stringify(input) });
}

export function updateEmployee(id: string, input: EmployeeInput): Promise<{ employee: Employee }> {
  return request(`/api/employees/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteEmployee(id: string): Promise<void> {
  return request(`/api/employees/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getEmployeeAssets(id: string): Promise<{ assets: AssetWithLiveInfo[] }> {
  return request(`/api/employees/${encodeURIComponent(id)}/assets`);
}

export function getEmployeeHistory(id: string): Promise<{ events: EmployeeHistoryEvent[] }> {
  return request(`/api/employees/${encodeURIComponent(id)}/history`);
}

export interface ImportEmployeesResult {
  index: number;
  employeeCode: string;
  name: string;
  action: "created" | "updated" | "failed";
  error?: string;
}

// `department` ตรงนี้เป็น plain text (ไม่ใช่ departmentId) — server จะ
// resolve ตามชื่อ และสร้างแผนกใหม่อัตโนมัติถ้ายังไม่มีที่ตรงกัน
export function importEmployees(
  rows: (EmployeeInput & { department?: string | null })[],
): Promise<{ results: ImportEmployeesResult[]; summary: { created: number; updated: number; failed: number } }> {
  return request("/api/employees/import", { method: "POST", body: JSON.stringify({ rows }) });
}

export function getPurchaseOrders(): Promise<{ purchaseOrders: PurchaseOrder[] }> {
  return request("/api/purchase-orders");
}

export function createPurchaseOrder(input: NewPurchaseOrderInput): Promise<{ purchaseOrder: PurchaseOrder }> {
  return request("/api/purchase-orders", { method: "POST", body: JSON.stringify(input) });
}

export function approvePurchaseOrder(id: string): Promise<{ purchaseOrder: PurchaseOrder }> {
  return request(`/api/purchase-orders/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

export function rejectPurchaseOrder(id: string): Promise<{ purchaseOrder: PurchaseOrder }> {
  return request(`/api/purchase-orders/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

export function cancelPurchaseOrder(id: string): Promise<{ purchaseOrder: PurchaseOrder }> {
  return request(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function receivePurchaseOrder(
  id: string,
  opts: { createAssets: boolean; assetCategory?: string | null },
): Promise<{ purchaseOrder: PurchaseOrder; createdAssetTags: string[] }> {
  return request(`/api/purchase-orders/${encodeURIComponent(id)}/receive`, { method: "POST", body: JSON.stringify(opts) });
}

export function deletePurchaseOrder(id: string): Promise<void> {
  return request(`/api/purchase-orders/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getMaintenanceRecords(assetTag?: string): Promise<{ records: MaintenanceRecord[] }> {
  return request(`/api/maintenance${assetTag ? `?assetTag=${encodeURIComponent(assetTag)}` : ""}`);
}

export function createMaintenanceRecord(input: MaintenanceInput & { assetTag: string; description: string }): Promise<{ record: MaintenanceRecord }> {
  return request("/api/maintenance", { method: "POST", body: JSON.stringify(input) });
}

export function updateMaintenanceRecord(id: string, input: MaintenanceInput): Promise<{ record: MaintenanceRecord }> {
  return request(`/api/maintenance/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function completeMaintenanceRecord(id: string, input: { completedDate?: string; cost?: number | null }): Promise<{ record: MaintenanceRecord }> {
  return request(`/api/maintenance/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify(input) });
}

export function deleteMaintenanceRecord(id: string): Promise<void> {
  return request(`/api/maintenance/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getHandovers(): Promise<{ handovers: Handover[] }> {
  return request("/api/handovers");
}

export function getHandover(id: string): Promise<{ handover: Handover }> {
  return request(`/api/handovers/${encodeURIComponent(id)}`);
}

export function createHandover(input: HandoverInput): Promise<{ handover: Handover }> {
  return request("/api/handovers", { method: "POST", body: JSON.stringify(input) });
}

export function acknowledgeHandover(id: string, proof?: AcknowledgeHandoverInput): Promise<{ handover: Handover }> {
  return request(`/api/handovers/${encodeURIComponent(id)}/acknowledge`, { method: "POST", body: JSON.stringify(proof ?? {}) });
}

export function getErpAlerts(withinDays = 30): Promise<ErpAlerts> {
  return request(`/api/erp/alerts?withinDays=${withinDays}`);
}

// --- Asset Management เฟส 2 ---

export function checkinAsset(assetTag: string): Promise<{ asset: AssetWithLiveInfo }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}/checkin`, { method: "POST" });
}

export function getAssetHistory(assetTag: string): Promise<{ events: AssetHistoryEvent[] }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}/history`);
}

export function getCustomFieldLabels(): Promise<{ labels: CustomFieldLabels }> {
  return request("/api/asset-custom-field-labels");
}

export function setCustomFieldLabels(labels: CustomFieldLabels): Promise<{ labels: CustomFieldLabels }> {
  return request("/api/asset-custom-field-labels", { method: "PUT", body: JSON.stringify(labels) });
}

export function getAssetModels(): Promise<{ assetModels: AssetModel[] }> {
  return request("/api/asset-models");
}

export function createAssetModel(input: AssetModelInput): Promise<{ assetModel: AssetModel }> {
  return request("/api/asset-models", { method: "POST", body: JSON.stringify(input) });
}

export function updateAssetModel(id: string, input: AssetModelInput): Promise<{ assetModel: AssetModel }> {
  return request(`/api/asset-models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteAssetModel(id: string): Promise<void> {
  return request(`/api/asset-models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getAssetRequests(): Promise<{ requests: AssetRequest[] }> {
  return request("/api/asset-requests");
}

export function createAssetRequest(assetTag: string, note?: string | null): Promise<{ request: AssetRequest }> {
  return request("/api/asset-requests", { method: "POST", body: JSON.stringify({ assetTag, note: note ?? null }) });
}

export function approveAssetRequest(id: string, employeeId?: string | null): Promise<{ request: AssetRequest }> {
  return request(`/api/asset-requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ employeeId: employeeId ?? null }) });
}

export function rejectAssetRequest(id: string): Promise<{ request: AssetRequest }> {
  return request(`/api/asset-requests/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

export function cancelAssetRequest(id: string): Promise<{ request: AssetRequest }> {
  return request(`/api/asset-requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function getLicenses(): Promise<{ licenses: SoftwareLicense[] }> {
  return request("/api/licenses");
}

export function createLicense(input: LicenseInput): Promise<{ license: SoftwareLicense }> {
  return request("/api/licenses", { method: "POST", body: JSON.stringify(input) });
}

export function updateLicense(id: string, input: LicenseInput): Promise<{ license: SoftwareLicense }> {
  return request(`/api/licenses/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteLicense(id: string): Promise<void> {
  return request(`/api/licenses/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function assignLicense(id: string, assetTag: string): Promise<{ license: SoftwareLicense }> {
  return request(`/api/licenses/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ assetTag }) });
}

export function unassignLicense(id: string, assetTag: string): Promise<void> {
  return request(`/api/licenses/${encodeURIComponent(id)}/assignments/${encodeURIComponent(assetTag)}`, { method: "DELETE" });
}

export function getCheckoutEula(orgId: string): Promise<{ checkoutEulaText: string | null }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/checkout-eula`);
}

export function setCheckoutEula(orgId: string, checkoutEulaText: string | null): Promise<{ checkoutEulaText: string | null }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/checkout-eula`, { method: "PUT", body: JSON.stringify({ checkoutEulaText }) });
}

// การจัดการบัญชีผู้ใช้ — server บังคับสิทธิ์เฉพาะ admin แยกต่างหากอยู่แล้วผ่าน
// requireRole (server/src/auth/roles.ts); call พวกนี้จะ 403 สำหรับคนอื่น
// เหมือน endpoint อื่น ๆ ทั่วไป
export function getUsers(): Promise<{ users: UserSummary[] }> {
  return request("/api/users");
}

export function createUserAccount(input: {
  username: string;
  password: string;
  role: Role;
  firstName: string;
  lastName: string;
  email?: string;
}): Promise<{ user: UserSummary }> {
  return request("/api/users", { method: "POST", body: JSON.stringify(input) });
}

export function updateUserAccount(
  id: string,
  input: { role?: Role; status?: "active" | "suspended"; password?: string; firstName?: string; lastName?: string; email?: string },
): Promise<{ user: UserSummary }> {
  return request(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteUserAccount(id: string): Promise<void> {
  return request(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// การจัดการองค์กร (tenant) — server บังคับเองแยกต่างหากว่าต้องเป็นองค์กรของ
// เจ้าของ platform เท่านั้น ผ่าน requirePlatformAdmin
// (server/src/api/routes.ts) รับประกัน "403 สำหรับคนอื่นทั้งหมด" เหมือนกับ
// endpoint อื่น ๆ ที่นี่
export interface OrganizationSummary {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  status: string;
  createdAt: string;
}

export function getOrganizations(): Promise<{ orgs: OrganizationSummary[] }> {
  return request("/api/orgs");
}

// domain: null คือล้างค่า ทำให้องค์กรกลับไปใช้รูปแบบ subdomain-under-
// orgDomainSuffix ที่ใช้ร่วมกันเหมือนองค์กรอื่น ๆ (ดู POST
// /orgs/:id/custom-domain ใน server/src/api/routes.ts และ
// migrations/0007_org_custom_domain.sql)
export function setCustomDomain(orgId: string, domain: string | null): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/custom-domain`, {
    method: "POST",
    body: JSON.stringify({ customDomain: domain }),
  });
}

// ทั้งสองฟิลด์เป็น optional — เปลี่ยนชื่อ, เปลี่ยน subdomain หรือทั้งคู่ในครั้งเดียวก็ได้
export function updateOrganization(orgId: string, input: { name?: string; subdomain?: string }): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

// การ suspend จะบล็อกทั้ง login ของคนและการเชื่อมต่อของ agent ในองค์กรนั้นทันที
// (ดู server/src/orgs/orgCredentials.ts และ orgResolver.ts)
export function setOrgStatus(orgId: string, status: "active" | "suspended"): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

// ลบองค์กรและทุกอย่างที่อยู่ในนั้นจริง ๆ แบบย้อนกลับไม่ได้ — ดู doc comment
// ของ deleteOrganization ใน server/src/orgs/orgsStore.ts
export function deleteOrganization(orgId: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE" });
}

export interface AuditEvent {
  id: string;
  actorUsername: string;
  orgId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export function getAuditEvents(opts: { limit: number; offset: number }): Promise<{ events: AuditEvent[]; total: number }> {
  return request(`/api/audit-events?limit=${opts.limit}&offset=${opts.offset}`);
}

export interface CreateOrgResult {
  org: OrganizationSummary;
  // แสดงเป็น raw text บน dashboard แค่ตรงนี้ที่เดียว ตอนสร้างเท่านั้น — ไม่ถูก
  // แสดงเป็นข้อความให้คัดลอกได้อีกที่ไหนอีกเลย แต่ยังฝังอยู่ใน installer .zip
  // ที่ generate ใหม่ได้ทุกเมื่อผ่าน downloadOrgInstaller ด้านล่าง (doc
  // comment ของ getOrganizationCredentials ใน server/src/orgs/orgsStore.ts
  // อธิบายว่าทำไมการเสิร์ฟซ้ำตรงนั้นถึงปลอดภัย)
  agentAuthToken: string;
  agentHmacSecret: string;
  admin: UserSummary;
  // เป็น null เฉพาะตอนที่ระบุ adminPassword มาโดยตรงแทน (ไม่ใช่เส้นทางปกติของ
  // dashboard — ดู createOrganization ด้านล่าง) นอกเหนือจากนั้นจะมีค่าเสมอ:
  // เป็นทางสำรองให้ platform admin ใช้เมื่อ setupLinkEmailed เป็น false
  setupLink: string | null;
  setupLinkEmailed: boolean;
}

// ถ้าไม่ระบุ adminPassword (เส้นทางปกติของ dashboard) → admin คนใหม่จะได้
// setup link แบบ self-service (ดู CreateOrgResult.setupLink) แทนที่
// platform admin จะเป็นคนตั้งรหัสผ่านให้โดยตรง
export function createOrganization(input: {
  name: string;
  subdomain: string;
  adminUsername: string;
  adminPassword?: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail?: string;
}): Promise<CreateOrgResult> {
  return request("/api/orgs", { method: "POST", body: JSON.stringify(input) });
}

// ไม่ได้สร้างบน request() — เหตุผลเดียวกับ downloadAgentInstaller คือ body
// เป็น binary ไม่ใช่ JSON ถูกสร้างใหม่สด ๆ ฝั่ง server ทุกครั้งที่เรียก (เป็น
// agent build ที่ active อยู่ปัจจุบันและ credential สดขององค์กรนั้นเสมอ) แทนที่
// จะเป็นไฟล์ static คงที่ จึงไม่มีอะไรต้องคอย sync
export async function downloadOrgInstaller(orgId: string, subdomain: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/orgs/${encodeURIComponent(orgId)}/installer`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `download failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `OptiFleet-Agent-${subdomain}-Deploy.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

// เครื่องมือ support สำหรับกรณี admin ขององค์กรลูกค้าถูกล็อกออก (ลืมรหัสผ่านของ
// บัญชีเดียวที่มี ทำให้การ reset แบบ self-service ในองค์กรเดียวกันบนหน้า Users
// เข้าไม่ถึง — เพราะ login เข้าไปเพื่อไปถึงหน้านั้นไม่ได้เลย) เฉพาะ
// platform-admin เท่านั้น (requirePlatformAdmin ใน
// server/src/api/routes.ts) — session ของ admin องค์กรลูกค้าเองเข้าถึงตรงนี้
// ไม่ได้ ขอบเขต 403 เดียวกับ GET/POST /orgs เอง
export function getOrgUsers(orgId: string): Promise<{ users: UserSummary[] }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users`);
}

export function resetOrgUserPassword(orgId: string, userId: string, password: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// สำหรับกรณี "setup link หมดอายุก่อนที่ลูกค้าจะใช้"
export function resendInvite(orgId: string, userId: string): Promise<{ setupLink: string; setupLinkEmailed: boolean }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(userId)}/resend-invite`, {
    method: "POST",
  });
}

// เป็น public — ยังไม่มี session อยู่เลย (ซึ่งคือประเด็นทั้งหมดของมัน) ถูกเรียกใช้
// จากหน้า /setup-password แบบ standalone ที่ admin ขององค์กรที่เพิ่งสร้าง
// ใหม่จะเข้าถึงผ่าน invite link ของตัวเอง
export function setupPassword(token: string, password: string): Promise<void> {
  return request("/api/auth/setup-password", { method: "POST", body: JSON.stringify({ token, password }) });
}

// --- Fixed-Asset Accounting: ผังบัญชี, สมุดรายวัน, รอบบัญชี, รอบคำนวณค่าเสื่อมราคา ---

export function getGlAccounts(): Promise<{ accounts: GlAccount[] }> {
  return request("/api/gl-accounts");
}

export function ensureDefaultGlAccounts(): Promise<{ accounts: GlAccount[] }> {
  return request("/api/gl-accounts/ensure-defaults", { method: "POST" });
}

export function createGlAccount(input: GlAccountInput): Promise<{ account: GlAccount }> {
  return request("/api/gl-accounts", { method: "POST", body: JSON.stringify(input) });
}

export function updateGlAccount(id: string, input: GlAccountInput): Promise<{ account: GlAccount }> {
  return request(`/api/gl-accounts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteGlAccount(id: string): Promise<void> {
  return request(`/api/gl-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// sourceId จำกัด scope ไปที่ audit trail ของ asset ตัวเดียว (รายการ
// acquisition/adjustment/retirement รวมถึงรายการ reverse ของมัน) — ดูแท็บ
// Accounting ในหน้ารายละเอียด asset
export function getJournalEntries(fiscalYear?: number, sourceId?: string): Promise<{ entries: JournalEntry[] }> {
  const params = new URLSearchParams();
  if (fiscalYear) params.set("fiscalYear", String(fiscalYear));
  if (sourceId) params.set("sourceId", sourceId);
  const qs = params.toString();
  return request(`/api/journal-entries${qs ? `?${qs}` : ""}`);
}

export function getJournalEntry(id: string): Promise<{ entry: JournalEntry }> {
  return request(`/api/journal-entries/${encodeURIComponent(id)}`);
}

export function reverseJournalEntry(id: string): Promise<{ entry: JournalEntry }> {
  return request(`/api/journal-entries/${encodeURIComponent(id)}/reverse`, { method: "POST" });
}

export function getFiscalPeriods(): Promise<{ periods: FiscalPeriod[] }> {
  return request("/api/fiscal-periods");
}

export function openFiscalYear(fiscalYear: number): Promise<{ period: FiscalPeriod }> {
  return request("/api/fiscal-periods/open", { method: "POST", body: JSON.stringify({ fiscalYear }) });
}

export function closeFiscalYear(fiscalYear: number): Promise<{ period: FiscalPeriod }> {
  return request("/api/fiscal-periods/close", { method: "POST", body: JSON.stringify({ fiscalYear }) });
}

export function getDepreciationRuns(): Promise<{ runs: DepreciationRun[] }> {
  return request("/api/depreciation-runs");
}

export function getDepreciationRun(id: string): Promise<{ run: DepreciationRun }> {
  return request(`/api/depreciation-runs/${encodeURIComponent(id)}`);
}

export function calculateDepreciationRun(input: { fiscalYear: number; period: number | null; runDate?: string }): Promise<{ run: DepreciationRun }> {
  return request("/api/depreciation-runs", { method: "POST", body: JSON.stringify(input) });
}

export function postDepreciationRun(id: string): Promise<{ run: DepreciationRun; journalEntry: JournalEntry }> {
  return request(`/api/depreciation-runs/${encodeURIComponent(id)}/post`, { method: "POST" });
}

export function reverseDepreciationRun(id: string): Promise<{ run: DepreciationRun }> {
  return request(`/api/depreciation-runs/${encodeURIComponent(id)}/reverse`, { method: "POST" });
}

export function getAccumulatedDepreciation(assetTag: string): Promise<{ accumulatedDepreciation: number }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}/accumulated-depreciation`);
}

// --- Asset lifecycle: การโอนย้าย, ตรวจนับจริง, การปรับปรุงรายการ, การตัดจำหน่าย ---

export function getAssetTransfers(assetTag?: string): Promise<{ transfers: AssetTransfer[] }> {
  return request(`/api/asset-transfers${assetTag ? `?assetTag=${encodeURIComponent(assetTag)}` : ""}`);
}

export function createAssetTransfer(input: AssetTransferInput): Promise<{ transfer: AssetTransfer }> {
  return request("/api/asset-transfers", { method: "POST", body: JSON.stringify(input) });
}

export function getCountCycles(): Promise<{ cycles: AssetCountCycle[] }> {
  return request("/api/asset-count-cycles");
}

export function getCountCycle(id: string): Promise<{ cycle: AssetCountCycle; lines: AssetCountLine[] }> {
  return request(`/api/asset-count-cycles/${encodeURIComponent(id)}`);
}

export function startCountCycle(name: string, dueDate: string | null): Promise<{ cycle: AssetCountCycle }> {
  return request("/api/asset-count-cycles", { method: "POST", body: JSON.stringify({ name, dueDate }) });
}

export function markAssetCounted(cycleId: string, lineId: string, input: { actualLocation?: string | null; notes?: string | null }): Promise<{ line: AssetCountLine }> {
  return request(`/api/asset-count-cycles/${encodeURIComponent(cycleId)}/lines/${encodeURIComponent(lineId)}/count`, { method: "POST", body: JSON.stringify(input) });
}

export function closeCountCycle(id: string): Promise<{ cycle: AssetCountCycle }> {
  return request(`/api/asset-count-cycles/${encodeURIComponent(id)}/close`, { method: "POST" });
}

export function getAssetAdjustments(assetTag?: string): Promise<{ adjustments: AssetAdjustment[] }> {
  return request(`/api/asset-adjustments${assetTag ? `?assetTag=${encodeURIComponent(assetTag)}` : ""}`);
}

export function createAssetAdjustment(input: AssetAdjustmentInput): Promise<{ adjustment: AssetAdjustment }> {
  return request("/api/asset-adjustments", { method: "POST", body: JSON.stringify(input) });
}

export function getAssetRetirements(): Promise<{ retirements: AssetRetirement[] }> {
  return request("/api/asset-retirements");
}

export function retireAsset(input: AssetRetirementInput): Promise<{ retirement: AssetRetirement }> {
  return request("/api/asset-retirements", { method: "POST", body: JSON.stringify(input) });
}
