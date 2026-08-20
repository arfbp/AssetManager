// HTTP API ฝั่ง dashboard: ส่งคำสั่งภาษาธรรมชาติ, การยืนยันจากมนุษย์สำหรับ
// action ที่ถูกตีธง, ควบคุม process โดยตรง, คำแนะนำการแก้ไขจาก AI และสถานะ
// fleet/history แบบอ่านอย่างเดียว
//
// Pipeline สำหรับ POST /api/command: parseNaturalLanguageCommand (LLM,
// parse intent ที่ยังไม่น่าเชื่อถือ) -> evaluateParsedIntent (guardrail,
// อำนาจตัดสินใจจริง) -> ไม่ dispatch ทันที ก็เก็บไว้เป็น pending
// confirmation หรือปฏิเสธไป
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { log, audit } from "../logger.js";
import type { Config } from "../config.js";
import type { AgentRegistry } from "../ws/registry.js";
import type { DeviceGroups } from "../groups/deviceGroups.js";
import type { CommandHistoryStore } from "../history/commandHistory.js";
import { dispatchToTargets } from "../ws/dispatch.js";
import { parseNaturalLanguageCommand, ParseRefusedError, ParseFailedError, RateLimitedError } from "../llm/actionParser.js";
import { suggestRemediation } from "../llm/remediationAdvisor.js";
import { analyzeDeviceForReplacement } from "../llm/deviceAnalysis.js";
import { answerDeviceQuery } from "../llm/queryAnswerer.js";
import { evaluateParsedIntent } from "../security/guardrail.js";
import { evaluateAdminIntent } from "../security/adminGuardrail.js";
import { executeAdminAction } from "../admin/executeAdminAction.js";
import { evaluateErpIntent } from "../security/erpGuardrail.js";
import { executeErpAction } from "../admin/executeErpAction.js";
import { scanForBlacklistedContent } from "../security/blacklist.js";
import { loginRateLimiter, createOrgRateLimiter } from "../security/rateLimiter.js";
import { PendingActionStore, type PendingAction, type PendingAdminAction, type PendingErpAction } from "./pendingActions.js";
import { verifyCredentials, listUsers, createUser, updateUserRole, updateUserProfile, resetPassword, deleteUser, otherAdminCount, setUserStatus, DuplicateUsernameError } from "../auth/users.js";
import { resolveOrgBySubdomain } from "../auth/orgResolver.js";
import { createSetupToken, consumeSetupToken } from "../auth/passwordSetup.js";
import { sendSetupLinkEmail } from "../notifications/channels/email.js";
import { createSession, deleteSession, validateSession, type Session } from "../auth/sessions.js";
import { requireRole } from "../auth/roles.js";
import { listAssets, listUnregisteredAgents, nextAssetTag, createAsset, updateAsset, deleteAsset, listAssetsWithExpiringWarranty, checkinAsset, listAssetsForEmployee } from "../assets/assetsStore.js";
import { getAssetHistory } from "../assets/assetHistory.js";
import { getCustomFieldLabels, setCustomFieldLabels } from "../assets/customFieldLabels.js";
import { listIncidents, listIncidentSummary } from "../incidents/incidentsStore.js";
import { listConnectionHistory } from "../assets/connectionHistoryStore.js";
import { listVendors, getVendor, createVendor, updateVendor, deleteVendor } from "../vendors/vendorsStore.js";
import { listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment, findDepartmentByName } from "../departments/departmentsStore.js";
import { listEmployees, getEmployee, getEmployeeByCode, createEmployee, updateEmployee, deleteEmployee } from "../employees/employeesStore.js";
import { getEmployeeHistory } from "../employees/employeeHistory.js";
import { listAssetModels, createAssetModel, updateAssetModel, deleteAssetModel } from "../assetModels/assetModelsStore.js";
import {
  listAssetRequests,
  createAssetRequest,
  setAssetRequestStatus,
  deleteAssetRequest,
  assignAssetRequestEmployee,
  InvalidAssetRequestTransitionError,
} from "../assetRequests/assetRequestsStore.js";
import {
  listLicenses,
  getLicense,
  createLicense,
  updateLicense,
  deleteLicense,
  assignLicense,
  unassignLicense,
  listLicensesWithExpiring,
} from "../licenses/licensesStore.js";
import {
  listPurchaseOrders,
  getPurchaseOrder,
  nextPoNumber,
  createPurchaseOrder,
  setPurchaseOrderStatus,
  deletePurchaseOrder,
  InvalidPoTransitionError,
} from "../procurement/purchaseOrdersStore.js";
import {
  listMaintenanceRecords,
  listUpcomingMaintenance,
  createMaintenanceRecord,
  updateMaintenanceRecord,
  completeMaintenanceRecord,
  deleteMaintenanceRecord,
} from "../maintenance/maintenanceStore.js";
import { listHandovers, getHandover, createHandover, acknowledgeHandover } from "../handovers/handoversStore.js";
import { listGlAccounts, getGlAccount, createGlAccount, updateGlAccount, deleteGlAccount, ensureDefaultAccounts, SystemAccountProtectedError } from "../accounting/glAccountsStore.js";
import { listJournalEntries, getJournalEntry, createJournalEntry, reverseJournalEntry, UnbalancedJournalEntryError, FiscalYearClosedError, AlreadyReversedError } from "../accounting/journalEntriesStore.js";
import { listFiscalPeriods, closeFiscalYear, openFiscalYear, FiscalYearOrderError } from "../accounting/fiscalPeriodsStore.js";
import {
  listDepreciationRuns,
  getDepreciationRun,
  calculateDepreciationRun,
  postDepreciationRun,
  reverseDepreciationRun,
  DepreciationRunNotDraftError,
  DepreciationRunNotPostedError,
  EmptyDepreciationRunError,
} from "../accounting/depreciationRunsStore.js";
import { getAccumulatedDepreciation } from "../assets/accumulatedDepreciation.js";
import { listAssetTransfers, createAssetTransfer } from "../assetTransfers/assetTransfersStore.js";
import { listCountCycles, getCountCycle, listCountLines, startCountCycle, markCounted, closeCountCycle } from "../assetCounts/assetCountsStore.js";
import { listAssetAdjustments, createAdjustment } from "../assetAdjustments/assetAdjustmentsStore.js";
import { listAssetRetirements, retireAsset, AssetAlreadyRetiredError } from "../assetRetirements/assetRetirementsStore.js";
import { lookupGeolocation } from "../geolocation/ipGeo.js";
import type { AgentBuildRegistry } from "../agentBuilds.js";
import {
  createOrganization,
  listOrganizations,
  getOrganizationCredentials,
  isValidSubdomain,
  DuplicateSubdomainError,
  PLATFORM_ORG_ID,
  setCustomDomain,
  DuplicateCustomDomainError,
  isValidCustomDomain,
  setOrgStatus,
  updateOrganization,
  deleteOrganization,
  PlatformOrgProtectedError,
  setOrgLogoContentType,
  getOrgLogoContentType,
  setCheckoutEulaText,
  getCheckoutEulaText,
} from "../orgs/orgsStore.js";
import { recordAuditEvent, listAuditEvents } from "../audit/auditStore.js";
import type { OrgCredentialCache } from "../orgs/orgCredentials.js";
import { streamOrgInstallerZip } from "../orgs/installerGenerator.js";

const MASS_ACTION_THRESHOLD = 3;

// requestedBy ไม่เคยมาจาก request body เลย — มันถูก derive จาก
// authenticated session (req.user.username) ด้านล่าง field แบบ "ใครเป็นคน
// ทำ" ที่ client ส่งมาเองจะเป็นตัวตนที่ไม่ได้ verify แบบเดียวกับที่ระบบ
// login มีไว้เพื่อแทนที่พอดี — ดู AuthedRequest / auth middleware
const CommandRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  // Override device/group แบบ optional จาก device selector ของ dashboard —
  // เมื่อ operator เลือก target device ไว้แล้ว ให้เชื่อค่านั้นแทนที่จะให้
  // LLM ต้อง extract scope จาก free text เองด้วย เลี่ยง bug ทั้งกลุ่มที่
  // โปรเจกต์นี้เจอซ้ำๆ (model ใส่ชื่ออุปกรณ์ผิด field หรืออ่านผิดไปเลย)
  // สำหรับ case ปกติที่ UI รู้ target อยู่แล้ว
  scope: z.string().min(1).max(200).optional(),
});

const KillProcessRequestSchema = z
  .object({
    pid: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
  })
  .refine((v) => v.pid !== undefined || v.name !== undefined, {
    message: "either pid or name is required",
  });

const RunScriptRequestSchema = z.object({
  script: z.string().min(1).max(32_768), // ตรงกับ max_script_bytes ใน configs/agent.yaml
});

const SuggestRemediationRequestSchema = z.object({
  pid: z.number().int().positive(),
});

const LoginRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const RoleEnum = z.enum(["admin", "it_support", "viewer"]);

const CreateUserRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
  role: RoleEnum,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  // Optional — ไม่ใช่ทุก organization ที่อยากเก็บค่านี้ และไม่จำเป็นสำหรับ
  // login (username/password จัดการเรื่องนั้นอยู่แล้ว)
  email: z.string().email().max(200).optional(),
});

const ResetOrgUserPasswordRequestSchema = z.object({
  password: z.string().min(8).max(200),
});

// adminPassword เป็น optional — เมื่อไม่ระบุ (ค่า default ของ dashboard ดู
// CreateOrgModal) admin คนใหม่จะได้ลิงก์ตั้งค่าแบบ self-service แทนที่
// platform admin จะเลือกรหัสผ่านแล้วส่งต่อให้เอง ยังคงเก็บไว้ให้ใช้ได้
// สำหรับการสร้าง org ผ่าน CLI/script ที่ไม่มีทางส่งลิงก์ตั้งค่าตามธรรมชาติ
// และผู้เรียกควบคุมบัญชีนั้นได้โดยตรง
const CreateOrgRequestSchema = z.object({
  name: z.string().min(1).max(200),
  subdomain: z.string().min(1).max(63),
  adminUsername: z.string().min(1).max(100),
  adminPassword: z.string().min(8).max(200).optional(),
  adminFirstName: z.string().min(1).max(100),
  adminLastName: z.string().min(1).max(100),
  adminEmail: z.string().email().max(200).optional(),
});

const SetupPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

// customDomain: null คือล้างค่าทิ้ง กลับไปใช้รูปแบบ
// subdomain-under-orgDomainSuffix ที่ใช้ร่วมกันแบบที่ org อื่นทุกตัวใช้
const SetCustomDomainRequestSchema = z.object({
  customDomain: z.string().min(1).max(253).nullable(),
});

// ทั้งสอง field เป็น optional รูปแบบเดียวกับ "รวมไว้ในเรียกเดียว" ของ
// UpdateUserRequestSchema ด้านล่าง
const UpdateOrgRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subdomain: z.string().min(1).max(63).optional(),
});

const StatusEnum = z.enum(["active", "suspended"]);

const SetOrgStatusRequestSchema = z.object({
  status: StatusEnum,
});

// ทุก field เป็น optional: PATCH /users/:id เปลี่ยนแค่ role อย่างเดียว
// password อย่างเดียว profile field อย่างเดียว status อย่างเดียว หรือ
// รวมกันในเรียกเดียวก็ได้ — ไม่ต้องส่ง record ทั้งหมดซ้ำ
const UpdateUserRequestSchema = z.object({
  role: RoleEnum.optional(),
  status: StatusEnum.optional(),
  password: z.string().min(8).max(200).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().max(200).optional(),
});

const AssetStatusEnum = z.enum(["ready_to_deploy", "deployed", "in_repair", "retired"]);
const AssetTypeEnum = z.enum(["computer", "peripheral"]);

const CreateAssetSchema = z.object({
  assetTag: z.string().min(1).max(100).optional(),
  agentId: z.string().max(200).nullable().optional(),
  status: AssetStatusEnum.optional(),
  category: z.string().max(200).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  orderNumber: z.string().max(200).nullable().optional(),
  checkedOutTo: z.string().max(200).nullable().optional(),
  checkedOutToEmail: z.string().max(200).nullable().optional(),
  checkedOutToDepartment: z.string().max(200).nullable().optional(),
  checkoutDate: z.string().max(30).nullable().optional(),
  expectedCheckinDate: z.string().max(30).nullable().optional(),
  eolDate: z.string().max(30).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  manualSerialNumber: z.string().max(200).nullable().optional(),
  assetType: AssetTypeEnum.optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  parentAgentId: z.string().max(200).nullable().optional(),
  purchaseCost: z.number().min(0).max(100_000_000).nullable().optional(),
  purchaseDate: z.string().max(30).nullable().optional(),
  depreciationYears: z.number().int().min(1).max(100).nullable().optional(),
  salvageValue: z.number().min(0).max(100_000_000).nullable().optional(),
  warrantyExpiryDate: z.string().max(30).nullable().optional(),
  assetModelId: z.string().uuid().nullable().optional(),
  checkedOutToEmployeeId: z.string().uuid().nullable().optional(),
  vendorId: z.string().uuid().nullable().optional(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  customField1: z.string().max(500).nullable().optional(),
  customField2: z.string().max(500).nullable().optional(),
  customField3: z.string().max(500).nullable().optional(),
  customField4: z.string().max(500).nullable().optional(),
  customField5: z.string().max(500).nullable().optional(),
  isRequestable: z.boolean().optional(),
});

const UpdateAssetSchema = CreateAssetSchema.omit({ assetTag: true });

// Bulk import (flow "Import" ของ Asset Registry) — แต่ละแถว validate ด้วย
// กฎเดียวกันเป๊ะกับการส่งฟอร์ม "New asset" ด้วยมือทีละรายการ
// (CreateAssetSchema) แค่เป็น array เท่านั้น จำกัดไว้ที่ 1000 แถว: กว้างพอ
// สำหรับการ import สเปรดชีตจริง แต่เล็กพอที่ request เดียวจะไม่ถูกใช้แฮง
// เซิร์ฟเวอร์ด้วยการประมวลผล CSV ที่ไม่มีขอบเขต
const ImportAssetsRequestSchema = z.object({
  rows: z.array(CreateAssetSchema).min(1).max(1000),
});

// --- Asset Management ERP: vendors, purchase orders, maintenance, handovers (ผู้ขาย, ใบสั่งซื้อ, งานซ่อมบำรุง, การส่งมอบ) ---

const VendorSchema = z.object({
  name: z.string().min(1).max(200),
  contactName: z.string().max(200).nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  legalName: z.string().max(200).nullable().optional(),
  taxId: z.string().max(50).nullable().optional(),
  paymentTerms: z.string().max(200).nullable().optional(),
  bankAccountInfo: z.string().max(500).nullable().optional(),
  category: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateVendorSchema = VendorSchema.partial();

const DepartmentSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateDepartmentSchema = DepartmentSchema.partial();

const EmployeeStatusEnum = z.enum(["active", "inactive"]);
const EmployeeSchema = z.object({
  name: z.string().min(1).max(200),
  employeeCode: z.string().max(50).nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  phone: z.string().max(50).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  status: EmployeeStatusEnum.optional(),
  startDate: z.string().max(30).nullable().optional(),
  endDate: z.string().max(30).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateEmployeeSchema = EmployeeSchema.partial();

// Bulk import (flow "Import" ของหน้า Employees) — รูปแบบ/เพดานเดียวกับ
// ImportAssetsRequestSchema `departmentId` (เป็น UUID ที่สเปรดชีตของ
// operator เองไม่มีทางมี) ถูกแทนที่ด้วยคอลัมน์ `department` แบบ plain-text
// ที่ resolve ชื่อฝั่งเซิร์ฟเวอร์ — ดู route handler ว่าทำไมการ resolve นี้
// ถึงยอมให้ auto-create ได้ ต่างจากการ match ชื่อพนักงานที่อื่น
const ImportEmployeeRowSchema = EmployeeSchema.omit({ departmentId: true }).extend({
  department: z.string().max(200).nullable().optional(),
});
const ImportEmployeesRequestSchema = z.object({
  rows: z.array(ImportEmployeeRowSchema).min(1).max(1000),
});

const PurchaseOrderItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().int().min(1).max(100_000),
  unitCost: z.number().min(0).max(100_000_000),
  assetCategory: z.string().max(200).nullable().optional(),
});

const CreatePurchaseOrderSchema = z.object({
  vendorId: z.string().uuid(),
  orderDate: z.string().max(30).nullable().optional(),
  expectedDeliveryDate: z.string().max(30).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(PurchaseOrderItemSchema).min(1).max(200),
});

const ReceivePurchaseOrderSchema = z.object({
  // ถ้าเป็น true จะสร้างแถว asset แบบ bulk ทีละ line item (quantity ถูก
  // กระจายเป็นแถวเดี่ยวๆ) แต่ละแถว prefill ด้วย unit_cost ของ item นั้นเป็น
  // purchase_cost และวันที่วันนี้เป็น purchase_date — ดู route handler ว่า
  // ทำไมส่วนนี้ถึงข้ามไปยังอาณาเขตของ assetsStore.ts แทนที่จะอยู่ใน
  // purchaseOrdersStore.ts
  createAssets: z.boolean().optional(),
  assetCategory: z.string().max(200).nullable().optional(),
});

const MaintenanceTypeEnum = z.enum(["scheduled", "repair", "inspection"]);
const MaintenanceStatusEnum = z.enum(["scheduled", "completed", "cancelled"]);

const CreateMaintenanceSchema = z.object({
  assetTag: z.string().min(1).max(100),
  type: MaintenanceTypeEnum.optional(),
  description: z.string().min(1).max(1000),
  scheduledDate: z.string().max(30).nullable().optional(),
  completedDate: z.string().max(30).nullable().optional(),
  status: MaintenanceStatusEnum.optional(),
  cost: z.number().min(0).max(100_000_000).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateMaintenanceSchema = CreateMaintenanceSchema.omit({ assetTag: true }).partial();

const CompleteMaintenanceSchema = z.object({
  completedDate: z.string().max(30).optional(),
  cost: z.number().min(0).max(100_000_000).nullable().optional(),
});

const CreateHandoverSchema = z
  .object({
    assetTag: z.string().min(1).max(100),
    // เลือกพนักงานจาก directory หรือพิมพ์ชื่อเอาก็ได้ — employeeId ชนะถ้า
    // ส่งมาทั้งคู่ (ฟอร์มจะส่งมาแค่ตัวใดตัวหนึ่งเท่านั้น)
    employeeId: z.string().uuid().nullable().optional(),
    employeeName: z.string().max(200).optional(),
    employeeEmail: z.string().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
    employeeDepartment: z.string().max(200).nullable().optional(),
    handoverDate: z.string().max(30).optional(),
    conditionNotes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Boolean(v.employeeId) || Boolean(v.employeeName?.trim()), {
    message: "Pick an employee from the directory or type a name.",
  });

const AcknowledgeHandoverSchema = z.object({
  employeeSignature: z.string().max(500_000).nullable().optional(),
  eulaAccepted: z.boolean().optional(),
});

// --- Asset Management เฟส 2: models, custom fields, requests, licenses ---

const AssetModelSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  depreciationYears: z.number().int().min(1).max(100).nullable().optional(),
  salvageValue: z.number().min(0).max(100_000_000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateAssetModelSchema = AssetModelSchema.partial();

const CustomFieldLabelsSchema = z.object({
  field1Label: z.string().max(100).nullable().optional(),
  field2Label: z.string().max(100).nullable().optional(),
  field3Label: z.string().max(100).nullable().optional(),
  field4Label: z.string().max(100).nullable().optional(),
  field5Label: z.string().max(100).nullable().optional(),
});

const CreateAssetRequestSchema = z.object({
  assetTag: z.string().min(1).max(100),
  note: z.string().max(1000).nullable().optional(),
});

// Body เป็น optional ตอน approve — org ที่ยังไม่ได้สร้าง employee directory
// ก็ยัง approve request ได้เหมือนเดิมทุกอย่าง (body ว่างเปล่า)
const ApproveAssetRequestSchema = z.object({
  employeeId: z.string().uuid().nullable().optional(),
});

const LicenseSchema = z.object({
  name: z.string().min(1).max(200),
  vendorId: z.string().uuid().nullable().optional(),
  licenseKey: z.string().max(500).nullable().optional(),
  seats: z.number().int().min(0).max(1_000_000).nullable().optional(),
  purchaseDate: z.string().max(30).nullable().optional(),
  expiryDate: z.string().max(30).nullable().optional(),
  cost: z.number().min(0).max(100_000_000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateLicenseSchema = LicenseSchema.partial();

const AssignLicenseSchema = z.object({
  assetTag: z.string().min(1).max(100),
});

const CheckoutEulaSchema = z.object({
  checkoutEulaText: z.string().max(20_000).nullable(),
});

// --- Fixed-asset accounting: GL accounts, journal entries, fiscal periods, depreciation runs (บัญชีสินทรัพย์ถาวร) ---

const GlAccountTypeEnum = z.enum(["asset", "liability", "equity", "revenue", "expense"]);

const GlAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  type: GlAccountTypeEnum,
  isContra: z.boolean().optional(),
});
const UpdateGlAccountSchema = GlAccountSchema.partial();

const CalculateDepreciationRunSchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2100),
  period: z.number().int().min(1).max(12).nullable().optional(),
  runDate: z.string().max(30).optional(),
});

const CloseFiscalYearSchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2100),
});

// --- Asset lifecycle: transfers, physical counts, adjustments, retirements (วงจรชีวิตสินทรัพย์) ---

const AssetTransferSchema = z.object({
  assetTag: z.string().min(1).max(100),
  toLocation: z.string().max(200).nullable().optional(),
  fromDepartment: z.string().max(200).nullable().optional(),
  toDepartment: z.string().max(200).nullable().optional(),
  transferDate: z.string().max(30).optional(),
  reason: z.string().max(1000).nullable().optional(),
});

const StartCountCycleSchema = z.object({
  name: z.string().min(1).max(200),
  dueDate: z.string().max(30).nullable().optional(),
});

const MarkCountedSchema = z.object({
  actualLocation: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const AdjustmentFieldEnum = z.enum(["purchase_cost", "depreciation_years", "salvage_value", "warranty_expiry_date", "other"]);

const AssetAdjustmentSchema = z.object({
  assetTag: z.string().min(1).max(100),
  fieldChanged: AdjustmentFieldEnum,
  newValue: z.string().min(1).max(500),
  reason: z.string().max(1000).nullable().optional(),
  adjustmentDate: z.string().max(30).optional(),
});

const RetirementReasonEnum = z.enum(["disposed", "sold", "lost", "stolen", "donated", "other"]);

const AssetRetirementSchema = z.object({
  assetTag: z.string().min(1).max(100),
  reason: RetirementReasonEnum,
  disposalMethod: z.string().max(200).nullable().optional(),
  proceeds: z.number().min(0).max(100_000_000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  retirementDate: z.string().max(30).optional(),
});

interface AuthedRequest extends Request {
  user?: Session;
}

// จำนวน byte รวมที่เก็บอยู่ใน subdirectory ของ custom-installers ของ org
// ตอนนี้ — ใช้บังคับ quota ต่อ org บน POST /software-uploads (route นั้น
// จำกัดไฟล์เดียวไว้ที่ 300MB อยู่แล้ว แต่ก่อนหน้านี้ไม่มีอะไรจำกัดว่า org
// จะสะสมได้กี่ไฟล์ org เดียวอัปโหลด installer มากพอก็ทำให้ดิสก์ของ VPS เต็ม
// ได้สำหรับทุก tenant) โฟลเดอร์ที่ไม่มีอยู่ (org ที่ไม่เคยอัปโหลดอะไรเลย)
// ถือว่าว่างเปล่า ไม่ใช่ error
async function getDirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      try {
        return (await stat(path.join(dir, entry))).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export function buildRouter(
  cfg: Config,
  registry: AgentRegistry,
  deviceGroups: DeviceGroups,
  history: CommandHistoryStore,
  pool: Pool,
  agentBuildRegistry: AgentBuildRegistry,
  orgCredentials: OrgCredentialCache,
): express.Router {
  const router = express.Router();
  const pending = new PendingActionStore<PendingAction>();
  // Store แยกต่างหาก ยืนยันข้าม ID ของ device store ไม่ได้เลย — ดู doc
  // comment ของ pendingActions.ts และ security/adminGuardrail.ts
  const pendingAdmin = new PendingActionStore<PendingAdminAction>();
  // Store อิสระตัวที่สาม — ดู doc comment ของ pendingActions.ts และ
  // security/erpGuardrail.ts
  const pendingErp = new PendingActionStore<PendingErpAction>();

  // Limiter ต่อ org สำหรับ route ที่มีต้นทุนต่อการเรียกสูง (มีค่าใช้จ่ายเป็น
  // เงินจริง หรือใช้ CPU/disk/bandwidth มาก) — ดู doc comment ของ
  // security/rateLimiter.ts ว่าทำไมถึงคีย์ด้วย orgId แทน IP
  const commandRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 1000,
    limit: 30,
    message: "Too many commands dispatched. Try again in a minute.",
  });
  const installerRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: "Too many installer downloads. Try again later.",
  });
  const uploadRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: "Too many uploads. Try again later.",
  });
  const assetImportRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    message: "Too many bulk imports. Try again later.",
  });
  const employeeImportRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    message: "Too many bulk imports. Try again later.",
  });

  router.use(express.json({ limit: "64kb" }));

  // POST /auth/login เป็น route เดียวที่เข้าถึงได้โดยไม่มี session — ยื่น
  // token เพื่อขอ token ไม่ได้ ทุกอย่างที่เหลือต้องการแถว session ที่ยังไม่
  // หมดอายุใน Postgres (src/auth/sessions.ts) ไม่มี shared static fallback
  // token อีกต่อไปแล้ว
  router.post("/auth/login", loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = LoginRequestSchema.parse(req.body);
      // ส่งมาจาก frontend จาก window.location.hostname ไม่ได้อ่านจาก Host
      // ของ request นี้เอง — ดู doc comment ของ orgResolver.ts จะ fallback
      // ไปที่ "legacy" (fleet ก่อนยุค multi-tenant) เพื่อให้ client ที่ยังไม่
      // ได้อัปเดต หรือเรียก API ตรงๆ ด้วย IP/sslip.io hostname ที่ไม่มี
      // subdomain ให้ parse ยัง resolve ไปที่ org เดียวที่เคยมีอยู่ก่อนที่
      // header นี้จะมี
      const orgSubdomain = (req.headers["x-org-subdomain"] as string | undefined)?.trim() || "legacy";
      const org = await resolveOrgBySubdomain(pool, orgSubdomain);
      if (!org) {
        // ตั้งใจใช้ข้อความ generic เดียวกับรหัสผ่านผิด — ต้องไม่ให้ผู้เรียก
        // แยกแยะ "org ผิด" ออกจาก "credential ผิด" ได้ (การมีอยู่ของ org ไม่
        // ควร enumerate ได้)
        audit.warn({ orgSubdomain, username: body.username }, "auth: login failed (unknown org)");
        res.status(401).json({ error: "invalid username or password" });
        return;
      }
      const user = await verifyCredentials(pool, org.id, body.username, body.password);
      if (!user) {
        audit.warn({ orgSubdomain, username: body.username }, "auth: login failed");
        res.status(401).json({ error: "invalid username or password" });
        return;
      }
      const token = await createSession(pool, user.id);
      audit.info({ orgSubdomain, username: user.username, role: user.role }, "auth: login succeeded");
      // ให้ frontend แสดงเมนู "Organizations" เฉพาะ admin ของ platform owner
      // เองเท่านั้น — ดู PLATFORM_ORG_ID ของ orgsStore.ts
      const isPlatformAdmin = user.role === "admin" && org.id === PLATFORM_ORG_ID;
      res.json({ token, username: user.username, role: user.role, isPlatformAdmin, orgId: org.id });
    } catch (err) {
      next(err);
    }
  });

  // Public — ควบคุมด้วยการถือ one-time token เท่านั้น เหมือนกับที่ login
  // ถูกควบคุมด้วยการถือรหัสผ่าน ให้ admin ของ org ที่เพิ่งสร้างตั้งรหัสผ่าน
  // ของตัวเองจากลิงก์ setup แทนที่ platform admin จะเลือกรหัสผ่านแล้วส่งต่อ
  // เอง (ดู POST /orgs)
  router.post("/auth/setup-password", loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = SetupPasswordRequestSchema.parse(req.body);
      const ok = await consumeSetupToken(pool, body.token, body.password);
      if (!ok) {
        // ตั้งใจใช้ข้อความ generic — ไม่แยกแยะ "ไม่เคยมีอยู่" กับ "หมดอายุ"
        // กับ "ใช้ไปแล้ว" ให้ผู้เรียกที่มีแค่ token เห็น
        res.status(400).json({ error: "This setup link is invalid or has expired." });
        return;
      }
      audit.info({}, "auth: password set via setup link");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Public เหมือน login — หน้าจอ login ต้องรู้ branding ของ org ก่อนที่จะมี
  // session อยู่เลย อ่าน X-Org-Subdomain header ตัวเดียวกันเป๊ะกับที่ login
  // เองอ่าน (ดู session.ts's currentOrgSubdomain()) resolve แบบเดียวกัน
  // ตั้งใจคืนค่าแค่ field ที่ไม่ sensitive เท่านั้น (ชื่อ, มีโลโก้อยู่หรือไม่)
  // — ไม่มีอะไรตรงนี้เป็นความลับที่ผู้เรียกที่ยังไม่ authenticated ไม่ควรเห็น
  // ระดับความน่าเชื่อถือเดียวกับโลโก้บนเว็บไซต์สาธารณะทั่วไป
  router.get("/orgs/branding", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgSubdomain = (req.headers["x-org-subdomain"] as string | undefined)?.trim() || "legacy";
      const org = await resolveOrgBySubdomain(pool, orgSubdomain);
      if (!org) {
        res.status(404).json({ error: "unknown organization" });
        return;
      }
      const logoContentType = await getOrgLogoContentType(pool, org.id);
      res.json({ name: org.name, logoUrl: logoContentType ? `/api/orgs/${org.id}/logo` : null });
    } catch (err) {
      next(err);
    }
  });

  // Public — ดู doc comment ของ GET /orgs/branding ว่าทำไม stream สิ่งที่
  // ถูกอัปโหลดผ่าน POST /orgs/:id/logo ด้านล่าง ด้วย content-type จริง
  // (tracked ไว้ใน organizations.logo_content_type ไม่ได้ sniff จากไฟล์)
  // 404 ถ้า org นี้ไม่ได้ตั้งโลโก้กำหนดเองไว้
  router.get("/orgs/:id/logo", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const contentType = await getOrgLogoContentType(pool, orgId);
      if (!contentType) {
        res.status(404).json({ error: "no custom logo set for this organization" });
        return;
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      createReadStream(path.join(cfg.orgLogosDir, orgId)).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  router.use(async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const session = await validateSession(pool, token);
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.user = session;
    next();
  });

  router.post("/auth/logout", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await deleteSession(pool, req.user!.token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/me", (req: AuthedRequest, res: Response) => {
    const isPlatformAdmin = req.user!.role === "admin" && req.user!.orgId === PLATFORM_ORG_ID;
    res.json({ username: req.user!.username, role: req.user!.role, isPlatformAdmin, orgId: req.user!.orgId });
  });

  // การจัดการบัญชี user — admin เท่านั้น (ดู auth/roles.ts) ทุกอย่างในนี้
  // คือจุดบังคับใช้ที่สองที่เป็นอิสระ นอกเหนือจากที่ client แค่ซ่อนเมนู
  // Users ไว้สำหรับคนที่ไม่ใช่ admin: session ที่ไม่ใช่ admin เรียกตรงๆ
  // ก็ยังได้ 403 จริง
  router.get("/users", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const users = await listUsers(pool, req.user!.orgId);
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  router.post("/users", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateUserRequestSchema.parse(req.body);
      const user = await createUser(pool, req.user!.orgId, body.username, body.password, body.role, {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email ?? null,
      });
      audit.info({ requestedBy: req.user!.username, username: user.username, role: user.role }, "users: created");
      res.status(201).json({ user });
    } catch (err) {
      if (err instanceof DuplicateUsernameError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.patch("/users/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.orgId;
      const targetId = req.params.id ?? "";
      const body = UpdateUserRequestSchema.parse(req.body);

      // การเปลี่ยน role ที่จะทำให้เหลือ admin ศูนย์คนคือการล็อกเอาต์จริง
      // (ไม่มี self-registration path ให้กู้คืน) — เช็คก่อนเขียนข้อมูล ไม่ได้
      // ปล่อยให้ UI เป็นคนป้องกันอย่างเดียว เพราะ endpoint นี้คืออำนาจ
      // ตัดสินใจจริง otherAdminCount/listUsers ทั้งคู่ scope ตาม org ดังนั้น
      // targetId ที่เป็นของ org อื่นจะแค่หาไม่เจอด้านล่าง (404) ไม่มีทางถูก
      // กระทำแบบเงียบๆ ได้
      if (body.role && body.role !== "admin") {
        const remainingAdmins = await otherAdminCount(pool, orgId, targetId);
        const targetIsCurrentlyAdmin = (await listUsers(pool, orgId)).find((u) => u.id === targetId)?.role === "admin";
        if (targetIsCurrentlyAdmin && remainingAdmins === 0) {
          res.status(409).json({ error: "Can't change this account's role — it's the last remaining admin." });
          return;
        }
      }

      // เหตุผลการล็อกเอาต์เดียวกับ guard ตอนเปลี่ยน role ด้านบน — การ suspend
      // เท่ากับการเอาสิทธิ์เข้าถึงของ admin คนนั้นออกในทางปฏิบัติ จึงต้องผ่าน
      // การเช็ค last-admin และ self-action แบบเดียวกับที่ delete มีอยู่แล้ว
      // (self-delete ถูกบล็อกด้านล่างใน DELETE handler; self-suspend ถูก
      // บล็อกตรงนี้ด้วยเหตุผลเดียวกัน)
      if (body.status === "suspended") {
        if (targetId === req.user!.userId) {
          res.status(409).json({ error: "You can't suspend your own account." });
          return;
        }
        const targetIsCurrentlyAdmin = (await listUsers(pool, orgId)).find((u) => u.id === targetId)?.role === "admin";
        if (targetIsCurrentlyAdmin && (await otherAdminCount(pool, orgId, targetId)) === 0) {
          res.status(409).json({ error: "Can't suspend the last remaining admin account." });
          return;
        }
      }

      if (body.role) await updateUserRole(pool, orgId, targetId, body.role);
      if (body.status) await setUserStatus(pool, orgId, targetId, body.status);
      if (body.password) await resetPassword(pool, orgId, targetId, body.password);
      if (body.firstName !== undefined || body.lastName !== undefined || body.email !== undefined) {
        await updateUserProfile(pool, orgId, targetId, { firstName: body.firstName, lastName: body.lastName, email: body.email });
      }
      audit.info(
        { requestedBy: req.user!.username, targetId, roleChanged: Boolean(body.role), statusChanged: body.status, passwordReset: Boolean(body.password) },
        "users: updated",
      );
      const users = await listUsers(pool, orgId);
      const updated = users.find((u) => u.id === targetId);
      if (!updated) {
        res.status(404).json({ error: "user not found" });
        return;
      }
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/users/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.orgId;
      const targetId = req.params.id ?? "";
      if (targetId === req.user!.userId) {
        res.status(409).json({ error: "You can't delete your own account." });
        return;
      }
      const target = (await listUsers(pool, orgId)).find((u) => u.id === targetId);
      if (!target) {
        res.status(404).json({ error: "user not found" });
        return;
      }
      if (target.role === "admin" && (await otherAdminCount(pool, orgId, targetId)) === 0) {
        res.status(409).json({ error: "Can't delete the last remaining admin account." });
        return;
      }
      await deleteUser(pool, orgId, targetId);
      audit.info({ requestedBy: req.user!.username, targetId, targetUsername: target.username }, "users: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // การจัดการ organization (tenant) — ตั้งใจไม่ใช้แค่ requireRole("admin")
  // ธรรมดา เพราะจะทำให้ admin ของ org ไหนก็ได้สร้างหรือ enumerate ทุก org
  // อื่นบน deployment นี้ได้ จำกัดไว้เฉพาะ admin ของ platform-owner org
  // เท่านั้น (ดู PLATFORM_ORG_ID ของ orgsStore.ts) — วันนี้คือแค่คนเดียว
  // operator ของทั้ง install นี้ ไม่ใช่ความสามารถที่ admin ของ org ลูกค้าคน
  // ไหนมี
  function requirePlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (req.user!.role !== "admin" || req.user!.orgId !== PLATFORM_ORG_ID) {
      res.status(403).json({ error: "Your account does not have permission to manage organizations." });
      return;
    }
    next();
  }

  router.get("/orgs", requirePlatformAdmin, async (_req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgs = await listOrganizations(pool);
      res.json({ orgs });
    } catch (err) {
      next(err);
    }
  });

  router.post("/orgs", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateOrgRequestSchema.parse(req.body);
      const subdomain = body.subdomain.trim().toLowerCase();
      if (!isValidSubdomain(subdomain)) {
        res.status(422).json({ error: "Subdomain must be lowercase letters, digits, or hyphens, and can't start or end with a hyphen." });
        return;
      }

      const created = await createOrganization(pool, body.name, subdomain);
      // Credential ของ agent ของ org ใหม่จะมีอยู่แค่ใน Postgres เท่านั้น
      // จนกว่า cache ในหน่วยความจำตัวนี้จะ reload — ถ้าไม่มีส่วนนี้ agent ที่
      // ติดตั้งด้วย token ที่เพิ่ง generate จะถูก verifyClient ปฏิเสธจนกว่าจะ
      // ถึง server restart ครั้งถัดไป เพราะ ws/server.ts ไม่เคย query
      // Postgres ใหม่ต่อ connection เลย (ดู doc comment ของ orgCredentials.ts
      // เองว่าทำไมถึง cache ไว้แต่แรก)
      await orgCredentials.reload(pool);

      // ไม่ได้ส่ง adminPassword มา (ค่า default ของ dashboard) → generate
      // รหัสผ่านที่ไม่มีวันโผล่ให้เห็นที่ไหน แล้วสร้างลิงก์ setup แบบ
      // self-service แทน เพื่อให้รหัสผ่านจริงถูกเลือกโดยลูกค้าเอง ไม่ใช่
      // platform admin พิมพ์แล้วส่งต่อผ่าน chat/email การส่ง adminPassword
      // มาเองอย่างชัดเจน (สร้าง org ผ่าน CLI/script) จะข้ามส่วนนี้ไปทั้งหมด
      // และทำงานเหมือนเดิมทุกอย่าง
      const usesSetupLink = !body.adminPassword;
      const adminPassword = body.adminPassword ?? randomBytes(32).toString("hex");
      const firstAdmin = await createUser(pool, created.org.id, body.adminUsername, adminPassword, "admin", {
        firstName: body.adminFirstName,
        lastName: body.adminLastName,
        email: body.adminEmail ?? null,
      });

      let setupLink: string | null = null;
      let setupLinkEmailed = false;
      if (usesSetupLink) {
        const token = await createSetupToken(pool, firstAdmin.id);
        const base = cfg.http.orgDomainSuffix ? `https://${subdomain}${cfg.http.orgDomainSuffix}` : cfg.http.dashboardOrigins[0];
        setupLink = `${base}/setup-password?token=${token}`;
        if (cfg.notifications.email && body.adminEmail) {
          try {
            await sendSetupLinkEmail(cfg.notifications.email, body.adminEmail, created.org.name, setupLink);
            setupLinkEmailed = true;
          } catch (err) {
            // ไม่ fatal — ทั้ง org และ admin account มีอยู่แล้วทั้งคู่ และ
            // ลิงก์ก็ยังถูกคืนค่าด้านล่างให้ platform admin ส่งต่อเองได้
            // ดังนั้นปัญหา SMTP ตรงนี้ไม่ควรทำให้ดูเหมือน request สร้าง org
            // ทั้งหมดล้มเหลว
            audit.warn({ err, orgId: created.org.id }, "orgs: setup link email failed to send");
          }
        }
      }

      audit.info(
        { requestedBy: req.user!.username, orgId: created.org.id, subdomain, adminUsername: firstAdmin.username, usesSetupLink },
        "orgs: created",
      );
      await recordAuditEvent(pool, {
        actorUsername: req.user!.username,
        orgId: created.org.id,
        action: "org.created",
        details: { orgName: created.org.name, subdomain, adminUsername: firstAdmin.username },
      });
      res.status(201).json({
        org: created.org,
        agentAuthToken: created.agentAuthToken,
        agentHmacSecret: created.agentHmacSecret,
        admin: firstAdmin,
        setupLink,
        setupLinkEmailed,
      });
    } catch (err) {
      if (err instanceof DuplicateSubdomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof DuplicateUsernameError) {
        // ตัว org เองถูกสร้างและ commit ไปแล้วด้านบน — username admin ที่ชน
        // กันตรงนี้เป็นเรื่องจริงแต่ขอบเขตแคบ (org นี้ยังไม่มี admin account
        // ที่ใช้งานได้) จึงรายงานแยกต่างหาก แทนที่จะดูเหมือน request สร้าง
        // org ทั้งหมดล้มเหลว
        res.status(409).json({ error: `Organization created, but ${err.message}. Add its first admin from the Users page instead.` });
        return;
      }
      next(err);
    }
  });

  // Generate และ stream installer .zip ที่พร้อมรันสำหรับ org นี้ สร้างใหม่
  // สดๆ ทุกครั้งที่ request — ship agent build ที่ active อยู่ตอนนี้เสมอ
  // (agentBuildRegistry.getActive()) ไม่มีวันเป็นสำเนาเก่าค้าง และอ่าน
  // credential ของ org นี้ใหม่จาก Postgres แทนที่จะบังคับให้ผู้เรียกต้อง
  // copy เก็บไว้ก่อนหน้านี้ (ดู doc comment ของ getOrganizationCredentials ใน
  // orgsStore.ts ว่าทำไมการเสิร์ฟซ้ำแบบนี้ถึงปลอดภัย)
  router.get("/orgs/:id/installer", requirePlatformAdmin, installerRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const found = await getOrganizationCredentials(pool, orgId);
      if (!found) {
        res.status(404).json({ error: "organization not found" });
        return;
      }
      const active = agentBuildRegistry.getActive();
      if (!active) {
        res.status(409).json({ error: "No agent build has been uploaded yet (see Agent Updates) — nothing to package." });
        return;
      }
      audit.info({ requestedBy: req.user!.username, orgId, subdomain: found.org.subdomain }, "orgs: installer generated");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.installer_generated", details: { orgName: found.org.name } });
      streamOrgInstallerZip(res, { templateDir: cfg.agentInstallerTemplateDir, agentExePath: active.exePath }, found.org.subdomain, found.agentAuthToken, found.agentHmacSecret);
    } catch (err) {
      next(err);
    }
  });

  // เครื่องมือสนับสนุนสำหรับ case ที่เจาะจงมาก: "admin ของลูกค้าเองลืม
  // รหัสผ่าน และเป็นบัญชีเดียวใน org นั้น จึง login ไม่ได้เลย ใช้ระบบ
  // self-service reset ปกติในหน้า Users ไม่ได้เลยด้วยซ้ำ" — session ที่
  // scope ตาม org ของ platform admin เองเข้าไม่ถึง user ของ org อื่นผ่าน
  // route /users ปกติ (req.user.orgId เป็นตัวกั้น) จึงมี pair นี้อยู่เป็น
  // ข้อยกเว้นที่ตั้งใจไว้และจำกัดเฉพาะ platform-admin เท่านั้น
  // listUsers/resetPassword (auth/users.ts) รับ orgId เป็น param ชัดเจนอยู่
  // แล้วแทนที่จะสมมติว่าเป็นของผู้เรียกเอง — ใช้ซ้ำตรงนี้เลย แค่ส่ง :id
  // จาก URL แทน req.user!.orgId
  router.get("/orgs/:id/users", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const users = await listUsers(pool, req.params.id ?? "");
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/orgs/:id/users/:userId/reset-password",
    requirePlatformAdmin,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const orgId = req.params.id ?? "";
        const userId = req.params.userId ?? "";
        const body = ResetOrgUserPasswordRequestSchema.parse(req.body);
        await resetPassword(pool, orgId, userId, body.password);
        audit.info({ requestedBy: req.user!.username, orgId, targetUserId: userId }, "orgs: user password reset by platform admin");
        await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.user_password_reset", details: { targetUserId: userId } });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // สำหรับ case "ลิงก์ setup หมดอายุก่อนที่ลูกค้าจะใช้" — สร้าง token ใหม่
  // (token เก่าถ้ามี ปล่อยให้หมดอายุไปเอง เป็น single-use อยู่แล้วจึง replay
  // ไม่ได้) แล้วคืนค่า/ส่งซ้ำให้ รูปแบบเดียวกับ response setup-link ดั้งเดิม
  // ของ POST /orgs
  router.post(
    "/orgs/:id/users/:userId/resend-invite",
    requirePlatformAdmin,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const orgId = req.params.id ?? "";
        const userId = req.params.userId ?? "";
        const { rows } = await pool.query<{ email: string | null; org_name: string; subdomain: string }>(
          `SELECT u.email, o.name AS org_name, o.subdomain
           FROM users u JOIN organizations o ON o.id = u.org_id
           WHERE u.id = $1 AND u.org_id = $2`,
          [userId, orgId],
        );
        const row = rows[0];
        if (!row) {
          res.status(404).json({ error: "user not found" });
          return;
        }

        const token = await createSetupToken(pool, userId);
        const base = cfg.http.orgDomainSuffix ? `https://${row.subdomain}${cfg.http.orgDomainSuffix}` : cfg.http.dashboardOrigins[0];
        const setupLink = `${base}/setup-password?token=${token}`;

        let setupLinkEmailed = false;
        if (cfg.notifications.email && row.email) {
          try {
            await sendSetupLinkEmail(cfg.notifications.email, row.email, row.org_name, setupLink);
            setupLinkEmailed = true;
          } catch (err) {
            audit.warn({ err, orgId, targetUserId: userId }, "orgs: resend-invite email failed to send");
          }
        }

        audit.info({ requestedBy: req.user!.username, orgId, targetUserId: userId }, "orgs: setup link resent by platform admin");
        await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.invite_resent", details: { targetUserId: userId } });
        res.json({ setupLink, setupLinkEmailed });
      } catch (err) {
        next(err);
      }
    },
  );

  // ให้ org หนึ่งเข้าถึงได้ผ่านโดเมนของตัวเองเต็มรูปแบบ (เช่น
  // assets.360qm.co.th) แทนที่รูปแบบ subdomain-under-orgDomainSuffix ที่แชร์
  // กัน — ดู migrations/0007 และ orgResolver.ts ต้อง reload orgCredentials
  // หลังจากนี้ (เหมือนตอนสร้าง org ด้านบน) เพื่อให้ CORS check และการ
  // resolve login รับรู้การเปลี่ยนแปลงโดยไม่ต้อง restart
  router.post("/orgs/:id/custom-domain", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const body = SetCustomDomainRequestSchema.parse(req.body);
      const domain = body.customDomain ? body.customDomain.trim().toLowerCase() : null;
      if (domain && !isValidCustomDomain(domain)) {
        res.status(422).json({ error: "Custom domain must be a valid hostname (e.g. assets.example.com)." });
        return;
      }
      const org = await setCustomDomain(pool, orgId, domain);
      await orgCredentials.reload(pool);
      audit.info({ requestedBy: req.user!.username, orgId, customDomain: domain }, "orgs: custom domain updated");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.custom_domain_updated", details: { orgName: org.name, customDomain: domain } });
      res.json({ org });
    } catch (err) {
      if (err instanceof DuplicateCustomDomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // ให้ org ทำ branding ของตัวเองได้ — ตั้งใจไม่ใช้ requirePlatformAdmin:
  // จุดประสงค์หลักคือ self-service (admin ของ org เองอัปโหลดโลโก้ของตัวเอง)
  // โดยให้ platform admin เข้ามาช่วยได้เพิ่มเติมสำหรับ case support รูปแบบ
  // "self หรือ platform admin" เดียวกับการ reset password ข้าม org ของ
  // ManageUsersModal แค่เขียนไว้ในบรรทัดนี้เลยเพราะเป็น route เดียวที่ต้อง
  // ใช้จนถึงตอนนี้
  function requireSelfOrPlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
    const targetOrgId = req.params.id ?? "";
    const isSelf = req.user!.orgId === targetOrgId;
    const isPlatformAdmin = req.user!.role === "admin" && req.user!.orgId === PLATFORM_ORG_ID;
    if (!isSelf && !isPlatformAdmin) {
      res.status(403).json({ error: "Your account does not have permission to manage this organization's branding." });
      return;
    }
    next();
  }

  const ORG_LOGO_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);

  // express.raw() ผูกไว้กับ route นี้เท่านั้น เหมือน /software-uploads
  // ด้านบน — โลโก้เป็นรูปเล็กๆ ไม่ใช่ JSON แต่ก็ยังห่างไกลจากเพดาน 300mb
  // ของ route นั้นมาก จึงมีเพดานของตัวเองที่เล็กกว่ามาก
  router.post(
    "/orgs/:id/logo",
    requireRole("admin"),
    requireSelfOrPlatformAdmin,
    express.raw({ type: () => true, limit: "5mb" }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const orgId = req.params.id ?? "";
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "no file body received" });
          return;
        }
        const contentType = (req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
        if (!ORG_LOGO_CONTENT_TYPES.has(contentType)) {
          res.status(422).json({ error: `Unsupported logo file type "${contentType}". Use PNG, JPEG, SVG, or WebP.` });
          return;
        }
        await mkdir(cfg.orgLogosDir, { recursive: true });
        await writeFile(path.join(cfg.orgLogosDir, orgId), req.body);
        await setOrgLogoContentType(pool, orgId, contentType);
        audit.info({ requestedBy: req.user!.username, orgId, contentType, bytes: req.body.length }, "orgs: logo uploaded");
        await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.logo_updated", details: { contentType } });
        res.json({ logoUrl: `/api/orgs/${orgId}/logo` });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete("/orgs/:id/logo", requireRole("admin"), requireSelfOrPlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      await setOrgLogoContentType(pool, orgId, null);
      try {
        await unlink(path.join(cfg.orgLogosDir, orgId));
      } catch {
        // ไม่มีไฟล์บนดิสก์ (เช่น ถูกลบไปแล้ว หรือคอลัมน์ถูกตั้งไว้โดยไม่มี
        // ไฟล์ด้วยเหตุผลบางอย่าง) — การล้างคอลัมน์ด้านบนต่างหากที่สำคัญจริงๆ
        // สำหรับ "กลับไปใช้ mark default" ดังนั้นนี่ไม่ใช่ error case
      }
      audit.info({ requestedBy: req.user!.username, orgId }, "orgs: logo removed");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.logo_removed", details: {} });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // เปลี่ยนชื่อ org และ/หรือย้ายไป subdomain อื่น — ไม่ต้อง reload cache
  // เลยทั้งคู่: การ resolve login (orgResolver.ts) อ่าน subdomain สดจาก
  // Postgres เสมอ และการเช็ค orgDomainSuffix ของ CORS เป็นการ match suffix
  // แบบ dynamic ไม่ใช่สิ่งที่ cache ไว้ต่อ org (ต่างจาก
  // custom_domain/agent_auth_token ด้านบนที่ cache ไว้จริงๆ)
  router.patch("/orgs/:id", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const body = UpdateOrgRequestSchema.parse(req.body);
      const subdomain = body.subdomain !== undefined ? body.subdomain.trim().toLowerCase() : undefined;
      if (subdomain !== undefined && !isValidSubdomain(subdomain)) {
        res.status(422).json({ error: "Subdomain must be lowercase letters, digits, or hyphens, and can't start or end with a hyphen." });
        return;
      }
      const org = await updateOrganization(pool, orgId, { name: body.name, subdomain });
      audit.info({ requestedBy: req.user!.username, orgId, name: body.name, subdomain }, "orgs: updated");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.updated", details: { name: body.name, subdomain } });
      res.json({ org });
    } catch (err) {
      if (err instanceof DuplicateSubdomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // การ suspend บล็อกการ login ของมนุษย์ทันที (resolveOrgBySubdomain กรอง
  // status = 'active' อยู่แล้ว) และการเชื่อมต่อของ agent ตอน
  // reconnect/heartbeat ครั้งถัดไป (query ของ orgCredentials.reload ทำ
  // แบบเดียวกัน) — ไม่ต้องบังคับใช้ที่อื่นเพิ่ม ทั้งสอง path ผ่านสองจุดเช็ค
  // นี้อยู่แล้ว platform org เองไม่มีวันถูก suspend ได้เลย
  // (PlatformOrgProtectedError ของ orgsStore.ts) — เพราะจะล็อก platform
  // admin ทุกคนออกไปหมด
  router.post("/orgs/:id/status", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const body = SetOrgStatusRequestSchema.parse(req.body);
      const org = await setOrgStatus(pool, orgId, body.status);
      await orgCredentials.reload(pool);
      audit.info({ requestedBy: req.user!.username, orgId, status: body.status }, "orgs: status changed");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId, action: "org.status_changed", details: { orgName: org.name, status: body.status } });
      res.json({ org });
    } catch (err) {
      if (err instanceof PlatformOrgProtectedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // การลบจริง ย้อนกลับไม่ได้ — ดู doc comment ของ deleteOrganization ใน
  // orgsStore.ts ว่ามีอะไรถูกเคลียร์บ้างเป๊ะๆ และทำไมมันต้องเป็น
  // transaction แบบเรียงลำดับชัดเจน แทนที่จะเป็น DELETE เปล่าๆ (ทุก
  // foreign key ของ org_id ใน schema นี้เป็น RESTRICT ไม่ใช่ CASCADE โดย
  // ตั้งใจ) audit_events ของ org นี้ตั้งใจให้รอดอยู่ (ON DELETE SET NULL)
  router.delete("/orgs/:id", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const org = (await listOrganizations(pool)).find((o) => o.id === orgId);
      if (!org) {
        res.status(404).json({ error: "organization not found" });
        return;
      }
      await deleteOrganization(pool, orgId);
      await orgCredentials.reload(pool);
      audit.info({ requestedBy: req.user!.username, orgId, orgName: org.name }, "orgs: deleted");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: null, action: "org.deleted", details: { orgName: org.name, subdomain: org.subdomain } });
      res.status(204).end();
    } catch (err) {
      if (err instanceof PlatformOrgProtectedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // ประวัติ action ของ platform-admin — รองรับหน้า Audit Log ของ dashboard
  // ดู audit/auditStore.ts และ migrations/0010_audit_events.sql สำหรับ
  // ขอบเขต (เจาะจง action ของ platform-admin เท่านั้น ไม่ใช่กิจกรรมทั่วไป
  // ต่อ org)
  router.get("/audit-events", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const result = await listAuditEvents(pool, { limit, offset });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/agents", (req: AuthedRequest, res: Response) => {
    res.json({ agents: registry.listAll().filter((a) => a.orgId === req.user!.orgId) });
  });

  router.get("/agents/:id/telemetry", (req: AuthedRequest, res: Response) => {
    const agentId = req.params.id ?? "";
    const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
    if (!snapshot) {
      res.status(404).json({ error: "no telemetry available (agent offline or hasn't reported yet)" });
      return;
    }
    res.json({ snapshot });
  });

  // เทรนด์ประวัติ CPU/RAM/Disk ของอุปกรณ์หนึ่งตัว รองรับ history chart ของ
  // dashboard อ่าน telemetry_snapshots ตรงๆ (ถาวร ต่างจากสถานะ "ล่าสุดที่รู้"
  // ในหน่วยความจำของ AgentRegistry) — นี่คือเหตุผลที่ตารางนั้นมีอยู่ แทนที่
  // จะแค่เขียนทับแถวเดียวต่อ agent จำกัดไว้ที่ 2000 จุดไม่ว่า range จะเป็น
  // เท่าไหร่: ยังไม่มีการ downsample แบบ time-bucketed ดังนั้น range ยาวๆ
  // ที่ agent อยู่ใน alert mode (ช่วง 10 วินาที) อาจถึงเพดานก่อนที่จะครอบคลุม
  // ทั้งหน้าต่างเวลา — พอสำหรับดูเทรนด์คร่าวๆ ไม่ใช่ตัวแทน query Postgres
  // ตรงๆ เพื่อรายละเอียดที่ละเอียดกว่านี้
  router.get("/agents/:id/history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const hours = Math.min(Math.max(Number(req.query.hours ?? 6) || 6, 1), 168);

      // "ORDER BY recorded_at ASC LIMIT 2000" ธรรมดาจะตัดเหลือแค่ 2000 แถวที่
      // เก่าที่สุดในหน้าต่างเวลาแบบเงียบๆ — ระหว่างที่ alert-mode ยืดเยื้อ
      // (polling ลดลงเหลือทุก 10 วินาทีตอน CPU/mem เกิน threshold) แค่นั้น
      // ก็สร้างแถวเป็นพันๆ ได้ภายในวันเดียว จนใช้เพดานหมดก่อนที่ query จะ
      // ไปถึงวันหลังๆ เลย ยืนยันแล้ว: request ขอ 7 วันกลับมาแสดงแค่ข้อมูล
      // ของวันเดียว (จุดที่แน่นมาก) ไม่เคยเห็นอีกหกวันเลย แก้โดยแบ่ง range
      // ที่ขอมาเป็นจำนวนช่วงเวลาเท่าๆ กันคงที่ แล้วเอามาแค่หนึ่ง sample
      // (ล่าสุด) ต่อช่วง เพื่อให้ครอบคลุมทั้ง range ที่ขอมาเสมอ ไม่ว่า
      // polling interval เดิมจะทำให้ข้อมูลดิบไม่สม่ำเสมอแค่ไหนก็ตาม
      const targetPoints = 500;
      const bucketSeconds = Math.max(1, Math.ceil((hours * 3600) / targetPoints));

      const { rows } = await pool.query<{
        recorded_at: Date;
        cpu_percent: number;
        mem_percent: number;
        disks: { mount_point: string; used_percent: number; free_gb: number; total_gb: number }[] | null;
      }>(
        `WITH bucketed AS (
           SELECT
             recorded_at, cpu_percent, mem_percent, snapshot->'disks' AS disks,
             date_bin(($3 || ' seconds')::interval, recorded_at, TIMESTAMPTZ '2000-01-01') AS bucket
           FROM telemetry_snapshots
           WHERE org_id = $4 AND agent_id = $1 AND recorded_at > now() - (interval '1 hour' * $2::double precision)
         )
         SELECT recorded_at, cpu_percent, mem_percent, disks
         FROM (
           SELECT DISTINCT ON (bucket) recorded_at, cpu_percent, mem_percent, disks, bucket
           FROM bucketed
           ORDER BY bucket, recorded_at DESC
         ) sampled
         ORDER BY recorded_at ASC`,
        [agentId, hours, bucketSeconds, req.user!.orgId],
      );
      res.json({
        points: rows.map((r) => ({
          recordedAt: r.recorded_at,
          cpuPercent: r.cpu_percent,
          memPercent: r.mem_percent,
          disks: r.disks ?? [],
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // รวบรวมสรุปการใช้ทรัพยากร/ความน่าเชื่อถือล่าสุดของอุปกรณ์ แล้วให้ LLM
  // แนะนำเรื่องการเปลี่ยนเครื่องเป็นภาษาที่เข้าใจง่าย — ดู
  // llm/deviceAnalysis.ts ว่าทำไมถึงใช้เหตุผลจาก usage pattern แทนอายุ
  // ฮาร์ดแวร์ที่ระบบนี้ไม่มีทางรู้ได้
  router.get("/agents/:id/report", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const windowDays = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 30);
      const orgId = req.user!.orgId;

      const snapshot = registry.getTelemetry(orgId, agentId);
      if (!snapshot) {
        res.status(404).json({ error: "No telemetry available for this device yet." });
        return;
      }

      const { rows: statRows } = await pool.query<{
        avg_cpu: number | null;
        max_cpu: number | null;
        avg_mem: number | null;
        max_mem: number | null;
        sample_count: string;
      }>(
        `SELECT AVG(cpu_percent) AS avg_cpu, MAX(cpu_percent) AS max_cpu,
                AVG(mem_percent) AS avg_mem, MAX(mem_percent) AS max_mem,
                COUNT(*) AS sample_count
         FROM telemetry_snapshots
         WHERE org_id = $3 AND agent_id = $1 AND recorded_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );
      const stats = statRows[0];

      const { rows: diskRows } = await pool.query<{ worst_disk: number | null }>(
        `SELECT MAX((d->>'used_percent')::double precision) AS worst_disk
         FROM telemetry_snapshots, jsonb_array_elements(snapshot->'disks') AS d
         WHERE org_id = $3 AND agent_id = $1 AND recorded_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );

      const { rows: incidentRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM device_incidents
         WHERE org_id = $3 AND agent_id = $1 AND kind = 'process_not_responding' AND occurred_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );

      const report = {
        deviceId: agentId,
        model: snapshot.model || null,
        manufacturer: snapshot.manufacturer || null,
        osVersion: snapshot.os_version || null,
        uptimeSeconds: snapshot.uptime_seconds,
        windowDays,
        avgCpuPercent: stats?.avg_cpu ?? 0,
        maxCpuPercent: stats?.max_cpu ?? 0,
        avgMemPercent: stats?.avg_mem ?? 0,
        maxMemPercent: stats?.max_mem ?? 0,
        worstDiskUsedPercent: diskRows[0]?.worst_disk ?? null,
        incidentCount: Number(incidentRows[0]?.count ?? 0),
        sampleCount: Number(stats?.sample_count ?? 0),
      };

      const analysis = await analyzeDeviceForReplacement(report);
      res.json({ report, analysis });
    } catch (err) {
      next(err);
    }
  });

  router.get("/agents/:id/incidents", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const incidents = await listIncidents(pool, req.user!.orgId, agentId);
      res.json({ incidents });
    } catch (err) {
      next(err);
    }
  });

  // อันดับ "อุปกรณ์ที่มีปัญหามากที่สุด" ทั้ง fleet สำหรับ Dashboard — ดู
  // comment ของ listIncidentSummary เองว่าทำไมถึงเป็นแค่การนับ incident
  // ธรรมดา ไม่เคยเรียก LLM ต่ออุปกรณ์เลย
  router.get("/fleet/incident-summary", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 90);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 50);
      const devices = await listIncidentSummary(pool, req.user!.orgId, days, limit);
      res.json({ days, devices });
    } catch (err) {
      next(err);
    }
  });

  // ข้อมูลแผนที่ "Live Tracking" — ตำแหน่งโดยประมาณของ agent แต่ละตัวที่รู้
  // ผ่าน IP geolocation (ดู geolocation/ipGeo.ts ว่าทำไมถึงใช้ IP-based ไม่ใช่
  // GPS จริง และข้อจำกัดเรื่องความแม่นยำ/privacy-IP) ตัด lookup ที่ซ้ำกันด้วย
  // IP ก่อน เพราะ agent หลายตัวในออฟฟิศเดียวกันแชร์ address เดียวกัน — ไม่มี
  // เหตุผลต้อง lookup IP เดียวกันซ้ำสองครั้งใน request เดียว
  router.get("/fleet/locations", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agents = registry.listAll().filter((a) => a.orgId === req.user!.orgId);
      const geoByIp = new Map<string, Awaited<ReturnType<typeof lookupGeolocation>>>();

      // เลือก public IP ที่ agent รายงานเอง (public_ip ของ telemetry, การ
      // lookup ภายนอกจากตำแหน่งเครือข่ายของ agent เอง — ดู
      // internal/telemetry/publicip.go) มากกว่า remoteIp (สิ่งที่ WebSocket
      // connection ของเซิร์ฟเวอร์นี้เห็น ซึ่งจะเป็น public address จริงก็
      // ต่อเมื่อเซิร์ฟเวอร์นี้เองอยู่บนอินเทอร์เน็ต ไม่ใช่ LAN เดียวกับ agent
      // — สำหรับ deployment แบบ on-prem/LAN ค่านั้นก็แค่ private address
      // อีกตัว) fallback ไปที่ remoteIp เฉพาะตอนที่ agent ยังไม่ได้รายงาน
      // public IP เท่านั้น (เช่น เพิ่ง connect ก่อนที่ background lookup
      // จะเสร็จ)
      const ipFor = (agent: (typeof agents)[number]): string | null => agent.lastTelemetry?.public_ip || agent.remoteIp;

      for (const agent of agents) {
        const ip = ipFor(agent);
        if (!ip || geoByIp.has(ip)) continue;
        geoByIp.set(ip, await lookupGeolocation(pool, ip));
      }

      const devices = agents.map((agent) => {
        const ip = ipFor(agent);
        const geo = ip ? geoByIp.get(ip) : undefined;
        return {
          agentId: agent.agentId,
          status: agent.status,
          remoteIp: ip,
          isPrivate: geo?.isPrivate ?? null,
          city: geo?.city ?? null,
          region: geo?.region ?? null,
          country: geo?.country ?? null,
          lat: geo?.lat ?? null,
          lon: geo?.lon ?? null,
          isp: geo?.isp ?? null,
          asn: geo?.asn ?? null,
          zip: geo?.zip ?? null,
          timezone: geo?.timezone ?? null,
        };
      });
      res.json({ devices });
    } catch (err) {
      next(err);
    }
  });

  router.get("/command-history", (req: AuthedRequest, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    // history.recent() เองยังคง org-agnostic (เหตุผลเดียวกับ
    // AgentRegistry.listAll()) — กรองเป็น org ของผู้เรียกตรงนี้ โดยเอา
    // จำนวนสูงสุดที่ store เก็บไว้ก่อนจะ slice เหลือแค่ `limit` เพื่อไม่ให้
    // entry ล่าสุดที่ scope ตาม org ของ fleet ที่ยุ่งถูกเบียดออกไปโดย entry
    // ของ org อื่นที่ครอง ring buffer ที่ใช้ร่วมกันอยู่ด้านหน้า
    const entries = history.recent(500).filter((e) => e.orgId === req.user!.orgId).slice(0, limit);
    res.json({ entries });
  });

  // Asset registry — ข้อมูล inventory/procurement (location, เช็คเอาต์ให้ใคร,
  // order number, EOL date, ...) ที่ operator กรอกเอง join แบบอ่านอย่างเดียว
  // กับสิ่งที่ agent ที่เชื่อมโยงกันรายงานเองอัตโนมัติอยู่แล้ว
  // (serial/model/manufacturer/live status) ดู src/assets/assetsStore.ts
  router.get("/assets", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const [assets, unregisteredAgents] = await Promise.all([
        listAssets(pool, req.user!.orgId),
        listUnregisteredAgents(pool, req.user!.orgId),
      ]);
      res.json({ assets, unregisteredAgents });
    } catch (err) {
      next(err);
    }
  });

  // การลง acquisition entry แบบ best-effort (Dr 1500 Fixed Assets / Cr 2100
  // Accounts Payable) — ถูกเรียกจากทั้ง POST /assets และ PO-receive handler
  // ด้านล่างทุกครั้งที่มีการตั้ง purchaseCost ตั้งใจกลืน error ของตัวเอง
  // (log ไว้ ไม่เคย throw) เพื่อให้ org ที่ไม่เคยแตะระบบบัญชีเลยไม่เห็นความ
  // เปลี่ยนแปลงพฤติกรรมใดๆ ตอนสร้าง asset ปกติ มีแค่ org ที่ใช้ ledger จริงจัง
  // เท่านั้นที่จะได้ posting และแม้แต่ org พวกนั้น ปัญหาของ GL ก็ไม่ควรบล็อก
  // การลงทะเบียน asset
  async function postAcquisitionEntryIfNeeded(orgId: string, actorUsername: string, assetTag: string, purchaseCost: number | null | undefined, purchaseDate: string | null | undefined): Promise<void> {
    if (!purchaseCost || purchaseCost <= 0) return;
    try {
      const accounts = await ensureDefaultAccounts(pool, orgId);
      const fixedAssets = accounts.find((a) => a.code === "1500")!;
      const accountsPayable = accounts.find((a) => a.code === "2100")!;
      await createJournalEntry(pool, orgId, actorUsername, {
        entryDate: purchaseDate || new Date().toISOString().slice(0, 10),
        source: "asset_acquisition",
        sourceId: assetTag,
        description: `Acquisition of ${assetTag}`,
        lines: [
          { accountId: fixedAssets.id, debit: purchaseCost, memo: "Asset acquired" },
          { accountId: accountsPayable.id, credit: purchaseCost, memo: "Asset acquired" },
        ],
      });
    } catch (err) {
      log.warn({ err, orgId, assetTag }, "accounting: acquisition entry failed to post (asset creation still succeeded)");
    }
  }

  router.post("/assets", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateAssetSchema.parse(req.body);
      const assetTag = body.assetTag || (await nextAssetTag(pool, req.user!.orgId));
      const asset = await createAsset(pool, req.user!.orgId, assetTag, body);
      await postAcquisitionEntryIfNeeded(req.user!.orgId, req.user!.username, assetTag, body.purchaseCost, body.purchaseDate);
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: created");
      res.status(201).json({ asset });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "That asset tag or linked device is already registered to another asset." });
        return;
      }
      next(err);
    }
  });

  // Bulk import — frontend parse/preview CSV ที่ฝั่ง client เอง และจะเรียก
  // endpoint นี้ก็ต่อเมื่อ operator ตรวจสอบแล้วจริงๆ และคลิก "Confirm
  // import" (ดู ImportAssetsModal.tsx) endpoint นี้ไม่เคยเห็นไฟล์ดิบเลย
  // เห็นแค่แถวที่ parse แล้วในรูปแบบ asset ปกติ แถวถูก apply ทีละแถวตามลำดับ
  // แทนที่จะเป็น transaction เดียว — สเปรดชีตที่มี 40 แถวถูกต้องกับ 3 แถวพิมพ์
  // ผิด ควรยัง import 40 แถวได้ โดย 3 แถวที่ผิดรายงานกลับแยกทีละรายการ ไม่ใช่
  // rollback ทั้งหมดเพราะแถวเสียไม่กี่แถว ทำแบบเรียงลำดับ (ไม่ใช่
  // Promise.all) โดยเฉพาะเพื่อให้ logic ของ nextAssetTag() ("นับแถวปัจจุบัน
  // แล้วคืนค่า count+1") ไม่แจก tag ที่ generate เดียวกันให้สองแถวใน request
  // เดียวกันได้
  router.post("/assets/import", requireRole("admin", "it_support"), assetImportRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = ImportAssetsRequestSchema.parse(req.body);
      const results: { index: number; assetTag: string; action: "created" | "updated" | "failed"; error?: string }[] = [];

      for (let i = 0; i < body.rows.length; i++) {
        const row = body.rows[i]!;
        try {
          if (row.assetTag) {
            const updated = await updateAsset(pool, req.user!.orgId, row.assetTag, row);
            if (updated) {
              results.push({ index: i, assetTag: row.assetTag, action: "updated" });
              continue;
            }
            // ให้ tag มาแต่ยังไม่มีอยู่ — สร้างด้วย tag นั้นตรงๆ (operator ที่
            // import scheme asset-tag ของตัวเองคาดหวังว่า tag พวกนั้นจะถูก
            // ใช้ตามที่ระบุมาเป๊ะๆ ไม่ใช่ถูกแทนที่ด้วยตัวที่ auto-generate)
            const created = await createAsset(pool, req.user!.orgId, row.assetTag, row);
            results.push({ index: i, assetTag: created.assetTag, action: "created" });
          } else {
            const assetTag = await nextAssetTag(pool, req.user!.orgId);
            const created = await createAsset(pool, req.user!.orgId, assetTag, row);
            results.push({ index: i, assetTag: created.assetTag, action: "created" });
          }
        } catch (err) {
          const message =
            err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505"
              ? "Asset tag or linked device already registered to another asset."
              : err instanceof Error
                ? err.message
                : "Unknown error";
          results.push({ index: i, assetTag: row.assetTag ?? "", action: "failed", error: message });
        }
      }

      const summary = {
        created: results.filter((r) => r.action === "created").length,
        updated: results.filter((r) => r.action === "updated").length,
        failed: results.filter((r) => r.action === "failed").length,
      };
      audit.info({ requestedBy: req.user!.username, ...summary }, "assets: bulk import");
      res.json({ results, summary });
    } catch (err) {
      next(err);
    }
  });

  router.get("/assets/:assetTag/connection-history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const entries = await listConnectionHistory(pool, req.user!.orgId, assetTag);
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  router.put("/assets/:assetTag", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const body = UpdateAssetSchema.parse(req.body);
      const asset = await updateAsset(pool, req.user!.orgId, assetTag, body);
      if (!asset) {
        res.status(404).json({ error: "asset not found" });
        return;
      }
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: updated");
      res.json({ asset });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "That linked device is already registered to another asset." });
        return;
      }
      next(err);
    }
  });

  router.delete("/assets/:assetTag", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const deleted = await deleteAsset(pool, req.user!.orgId, assetTag);
      if (!deleted) {
        res.status(404).json({ error: "asset not found" });
        return;
      }
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Asset Management ERP ---------------------------------------------
  // (routes สำหรับ vendors, purchase orders, maintenance, handovers)

  router.get("/vendors", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ vendors: await listVendors(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/vendors", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = VendorSchema.parse(req.body);
      const vendor = await createVendor(pool, req.user!.orgId, body);
      audit.info({ vendorId: vendor.id, requestedBy: req.user!.username }, "vendors: created");
      res.status(201).json({ vendor });
    } catch (err) {
      next(err);
    }
  });

  router.put("/vendors/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateVendorSchema.parse(req.body);
      const vendor = await updateVendor(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!vendor) {
        res.status(404).json({ error: "vendor not found" });
        return;
      }
      audit.info({ vendorId: vendor.id, requestedBy: req.user!.username }, "vendors: updated");
      res.json({ vendor });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/vendors/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteVendor(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "vendor not found" });
        return;
      }
      audit.info({ vendorId: req.params.id, requestedBy: req.user!.username }, "vendors: deleted");
      res.status(204).end();
    } catch (err) {
      // Vendor ที่ถูกอ้างอิงโดย purchase order หรือถูกอ้างอิงตรงๆ โดย asset
      // (migrations/0029) ลบไม่ได้ — ทั้งสอง FK ไม่มี ON DELETE clause ดู
      // doc comment ของ migrations/0013 และ migrations/0029 — แสดงเป็น 409
      // ที่ชัดเจนแทนที่จะเป็น Postgres error ดิบๆ
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This vendor has purchase orders or assets on file and can't be deleted." });
        return;
      }
      next(err);
    }
  });

  // --- Departments (แผนก) -----------------------------------------------
  // ไม่มีเมนู nav หรือหน้า detail ของตัวเอง — จัดการผ่าน modal บนหน้า
  // Employees รูปแบบ CRUD เดียวกับ vendors ด้านบน

  router.get("/departments", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ departments: await listDepartments(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/departments", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = DepartmentSchema.parse(req.body);
      const department = await createDepartment(pool, req.user!.orgId, body);
      audit.info({ departmentId: department.id, requestedBy: req.user!.username }, "departments: created");
      res.status(201).json({ department });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "A department with that name already exists." });
        return;
      }
      next(err);
    }
  });

  router.put("/departments/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateDepartmentSchema.parse(req.body);
      const department = await updateDepartment(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!department) {
        res.status(404).json({ error: "department not found" });
        return;
      }
      audit.info({ departmentId: department.id, requestedBy: req.user!.username }, "departments: updated");
      res.json({ department });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "A department with that name already exists." });
        return;
      }
      next(err);
    }
  });

  router.delete("/departments/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteDepartment(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "department not found" });
        return;
      }
      audit.info({ departmentId: req.params.id, requestedBy: req.user!.username }, "departments: deleted");
      res.status(204).end();
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This department still has employees assigned and can't be deleted." });
        return;
      }
      next(err);
    }
  });

  // --- Employees (พนักงาน) -------------------------------------------------

  router.get("/employees", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ employees: await listEmployees(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/employees/:id", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const employee = await getEmployee(pool, req.user!.orgId, req.params.id ?? "");
      if (!employee) {
        res.status(404).json({ error: "employee not found" });
        return;
      }
      res.json({ employee });
    } catch (err) {
      next(err);
    }
  });

  router.get("/employees/:id/assets", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ assets: await listAssetsForEmployee(pool, req.user!.orgId, req.params.id ?? "") });
    } catch (err) {
      next(err);
    }
  });

  router.get("/employees/:id/history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ events: await getEmployeeHistory(pool, req.user!.orgId, req.params.id ?? "") });
    } catch (err) {
      next(err);
    }
  });

  router.post("/employees", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = EmployeeSchema.parse(req.body);
      // GET /users เองก็ admin-only — operator ที่เป็น it_support ไม่มีทาง
      // เห็นหรือตั้งค่าได้อย่างมีความหมายว่าพนักงานคนนี้ผูกกับ login ตัวไหน
      const input = req.user!.role === "admin" ? body : { ...body, userId: undefined };
      const employee = await createEmployee(pool, req.user!.orgId, input);
      audit.info({ employeeId: employee.id, requestedBy: req.user!.username }, "employees: created");
      res.status(201).json({ employee });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "An employee with that code (or linked login) already exists." });
        return;
      }
      next(err);
    }
  });

  router.put("/employees/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateEmployeeSchema.parse(req.body);
      const input = req.user!.role === "admin" ? body : { ...body, userId: undefined };
      const employee = await updateEmployee(pool, req.user!.orgId, req.params.id ?? "", input);
      if (!employee) {
        res.status(404).json({ error: "employee not found" });
        return;
      }
      audit.info({ employeeId: employee.id, requestedBy: req.user!.username }, "employees: updated");
      res.json({ employee });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "An employee with that code (or linked login) already exists." });
        return;
      }
      next(err);
    }
  });

  router.delete("/employees/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteEmployee(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "employee not found" });
        return;
      }
      audit.info({ employeeId: req.params.id, requestedBy: req.user!.username }, "employees: deleted");
      res.status(204).end();
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This employee has assets, handovers or requests on file and can't be deleted. Mark them inactive instead." });
        return;
      }
      next(err);
    }
  });

  router.post("/employees/import", requireRole("admin", "it_support"), employeeImportRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = ImportEmployeesRequestSchema.parse(req.body);
      const results: { index: number; employeeCode: string; name: string; action: "created" | "updated" | "failed"; error?: string }[] = [];
      // Cache ชื่อ department ที่ resolve แล้วภายใน request เดียวนี้ เพื่อให้
      // 500 แถวของ department เดียวกัน lookup (และถ้าเป็นของใหม่ สร้าง) แค่
      // ครั้งเดียว แทนที่จะชน race 500 ครั้ง
      const departmentIdByName = new Map<string, string | null>();

      for (let i = 0; i < body.rows.length; i++) {
        const { department, ...row } = body.rows[i]!;
        try {
          let departmentId: string | null | undefined;
          const departmentName = department?.trim();
          if (departmentName) {
            const cacheKey = departmentName.toLowerCase();
            if (departmentIdByName.has(cacheKey)) {
              departmentId = departmentIdByName.get(cacheKey)!;
            } else {
              // ต่างจาก *ชื่อ* พนักงาน ชื่อ department เป็น lookup label ที่
              // ต้นทุนต่ำ ความเสี่ยงต่ำ (unique แบบไม่สนตัวพิมพ์เล็กใหญ่ ไม่มี
              // ประวัติส่วนตัวติดมา) — การ auto-create ตัวที่ไม่รู้จักตอน
              // import คือพฤติกรรม "ใช้งานได้เลย" ที่คาดหวังไว้ ไม่ใช่ความ
              // เสี่ยงเรื่องการจับคู่ผิดแบบเงียบๆ ที่กฎ "ไม่ backfill
              // อัตโนมัติ" (migrations/0030) มีไว้ป้องกันสำหรับตัวบุคคล
              const found = await findDepartmentByName(pool, req.user!.orgId, departmentName);
              if (found === "ambiguous") {
                throw new Error(`Department "${departmentName}" matches more than one existing department — rename them to be distinct, or leave this column blank.`);
              }
              const resolved = found === "none" ? (await createDepartment(pool, req.user!.orgId, { name: departmentName })).id : found.id;
              departmentIdByName.set(cacheKey, resolved);
              departmentId = resolved;
            }
          }

          const input = { ...row, ...(departmentId !== undefined ? { departmentId } : {}) };
          const existing = row.employeeCode ? await getEmployeeByCode(pool, req.user!.orgId, row.employeeCode) : null;
          if (existing) {
            await updateEmployee(pool, req.user!.orgId, existing.id, input);
            results.push({ index: i, employeeCode: row.employeeCode ?? "", name: row.name, action: "updated" });
          } else {
            const created = await createEmployee(pool, req.user!.orgId, input);
            results.push({ index: i, employeeCode: created.employeeCode ?? "", name: created.name, action: "created" });
          }
        } catch (err) {
          const message =
            err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505"
              ? "Employee code (or linked login) already registered to another employee."
              : err instanceof Error
                ? err.message
                : "Unknown error";
          results.push({ index: i, employeeCode: row.employeeCode ?? "", name: row.name ?? "", action: "failed", error: message });
        }
      }

      const summary = {
        created: results.filter((r) => r.action === "created").length,
        updated: results.filter((r) => r.action === "updated").length,
        failed: results.filter((r) => r.action === "failed").length,
      };
      audit.info({ requestedBy: req.user!.username, ...summary }, "employees: bulk import");
      res.json({ results, summary });
    } catch (err) {
      next(err);
    }
  });

  router.get("/purchase-orders", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ purchaseOrders: await listPurchaseOrders(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/purchase-orders", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreatePurchaseOrderSchema.parse(req.body);
      const poNumber = await nextPoNumber(pool, req.user!.orgId);
      const po = await createPurchaseOrder(pool, req.user!.orgId, poNumber, req.user!.username, body);
      audit.info({ poNumber, requestedBy: req.user!.username }, "purchase-orders: created");
      res.status(201).json({ purchaseOrder: po });
    } catch (err) {
      next(err);
    }
  });

  // Approve/reject เป็น admin-only เท่านั้น — นี่คือความสามารถ "approval
  // workflow": admin คนไหนของ org ก็ตัดสินใจได้ ไม่จำเป็นต้องเป็นคนที่
  // request มาเอง (ไม่มี role "approver" แยกต่างหาก — ดู scoping note ของ
  // plan) ทั้งสอง branch ใช้ handler เดียวกันเพราะต่างกันแค่ status ที่จะ
  // เปลี่ยนไปเท่านั้น
  for (const [routeSuffix, toStatus] of [
    ["approve", "approved"],
    ["reject", "rejected"],
    ["cancel", "cancelled"],
  ] as const) {
    router.post(`/purchase-orders/:id/${routeSuffix}`, requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const po = await setPurchaseOrderStatus(pool, req.user!.orgId, req.params.id ?? "", toStatus, req.user!.username);
        if (!po) {
          res.status(404).json({ error: "purchase order not found" });
          return;
        }
        audit.info({ poNumber: po.poNumber, status: toStatus, requestedBy: req.user!.username }, `purchase-orders: ${toStatus}`);
        await recordAuditEvent(pool, {
          actorUsername: req.user!.username,
          orgId: req.user!.orgId,
          action: `purchase_order.${toStatus}`,
          details: { poNumber: po.poNumber },
        });
        res.json({ purchaseOrder: po });
      } catch (err) {
        if (err instanceof InvalidPoTransitionError) {
          res.status(409).json({ error: err.message });
          return;
        }
        next(err);
      }
    });
  }

  // ทำเครื่องหมาย PO ที่ approve แล้วว่า received และถ้าเลือกไว้ จะ
  // bulk-create แถว asset จาก line item ของมัน (quantity ถูกกระจายเป็นแถว
  // เดี่ยวๆ แต่ละแถว prefill purchase_cost จาก unit_cost ของ item และตอนนี้
  // ยังมี vendor_id/purchase_order_id ด้วย — ร่องรอย procurement แบบมี
  // โครงสร้างที่ Asset Registry join ด้วย ดู listAssets ของ assetsStore.ts)
  // — ข้ามไปยังอาณาเขตของ assetsStore.ts จึงอยู่ในไฟล์ routes.ts นี้แทนที่จะ
  // อยู่ใน purchaseOrdersStore.ts ตามหลัก "orchestration อยู่ใน route
  // handler" เดียวกับ POST /assets/import
  router.post("/purchase-orders/:id/receive", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = ReceivePurchaseOrderSchema.parse(req.body);
      const po = await setPurchaseOrderStatus(pool, req.user!.orgId, req.params.id ?? "", "received", undefined);
      if (!po) {
        res.status(404).json({ error: "purchase order not found" });
        return;
      }

      const createdAssetTags: string[] = [];
      if (body.createAssets) {
        const today = new Date().toISOString().slice(0, 10);
        for (const item of po.items) {
          for (let i = 0; i < item.quantity; i++) {
            const assetTag = await nextAssetTag(pool, req.user!.orgId);
            await createAsset(pool, req.user!.orgId, assetTag, {
              category: item.assetCategory ?? body.assetCategory ?? null,
              notes: `Received from ${po.poNumber} (${item.description})`,
              purchaseCost: item.unitCost,
              purchaseDate: today,
              vendorId: po.vendorId,
              purchaseOrderId: po.id,
            });
            await postAcquisitionEntryIfNeeded(req.user!.orgId, req.user!.username, assetTag, item.unitCost, today);
            createdAssetTags.push(assetTag);
          }
        }
      }

      audit.info({ poNumber: po.poNumber, requestedBy: req.user!.username, createdAssetTags }, "purchase-orders: received");
      await recordAuditEvent(pool, {
        actorUsername: req.user!.username,
        orgId: req.user!.orgId,
        action: "purchase_order.received",
        details: { poNumber: po.poNumber, createdAssetTags },
      });
      res.json({ purchaseOrder: po, createdAssetTags });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/purchase-orders/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deletePurchaseOrder(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "purchase order not found" });
        return;
      }
      audit.info({ poId: req.params.id, requestedBy: req.user!.username }, "purchase-orders: deleted");
      res.status(204).end();
    } catch (err) {
      // PO ที่ถูกอ้างอิงโดย asset ที่ received เข้ามา (purchase_order_id ของ
      // migrations/0029 ไม่มี ON DELETE clause) ลบไม่ได้ — แสดงเป็น 409
      // ที่ชัดเจนแทนที่จะเป็น Postgres error ดิบๆ pattern เดียวกับ DELETE
      // /vendors/:id ด้านบน
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This purchase order has assets received against it and can't be deleted." });
        return;
      }
      next(err);
    }
  });

  router.get("/maintenance", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = typeof req.query.assetTag === "string" ? req.query.assetTag : undefined;
      res.json({ records: await listMaintenanceRecords(pool, req.user!.orgId, assetTag) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/maintenance", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateMaintenanceSchema.parse(req.body);
      const record = await createMaintenanceRecord(pool, req.user!.orgId, body);
      audit.info({ recordId: record.id, assetTag: record.assetTag, requestedBy: req.user!.username }, "maintenance: created");
      res.status(201).json({ record });
    } catch (err) {
      next(err);
    }
  });

  router.put("/maintenance/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateMaintenanceSchema.parse(req.body);
      const record = await updateMaintenanceRecord(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!record) {
        res.status(404).json({ error: "maintenance record not found" });
        return;
      }
      audit.info({ recordId: record.id, requestedBy: req.user!.username }, "maintenance: updated");
      res.json({ record });
    } catch (err) {
      next(err);
    }
  });

  router.post("/maintenance/:id/complete", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CompleteMaintenanceSchema.parse(req.body);
      const record = await completeMaintenanceRecord(
        pool,
        req.user!.orgId,
        req.params.id ?? "",
        body.completedDate ?? new Date().toISOString().slice(0, 10),
        body.cost ?? null,
      );
      if (!record) {
        res.status(404).json({ error: "maintenance record not found" });
        return;
      }
      audit.info({ recordId: record.id, assetTag: record.assetTag, requestedBy: req.user!.username }, "maintenance: completed");
      await recordAuditEvent(pool, {
        actorUsername: req.user!.username,
        orgId: req.user!.orgId,
        action: "maintenance.completed",
        details: { assetTag: record.assetTag, description: record.description },
      });
      res.json({ record });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/maintenance/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteMaintenanceRecord(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "maintenance record not found" });
        return;
      }
      audit.info({ recordId: req.params.id, requestedBy: req.user!.username }, "maintenance: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/handovers", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ handovers: await listHandovers(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  // Public ภายใน session ของ org เอง (ต้อง auth เหมือน route อื่นทุกตัวใน
  // นี้) — รองรับหน้า handover ที่พิมพ์ได้ ซึ่งต้องการ record เต็มด้วย id
  // แทนที่จะกรอง list ที่ฝั่ง client
  router.get("/handovers/:id", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const handover = await getHandover(pool, req.user!.orgId, req.params.id ?? "");
      if (!handover) {
        res.status(404).json({ error: "handover not found" });
        return;
      }
      res.json({ handover });
    } catch (err) {
      next(err);
    }
  });

  router.post("/handovers", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateHandoverSchema.parse(req.body);
      // การ resolve ข้ามตารางอยู่ใน route handler ไม่ใช่ใน store (ตามหลัก
      // เดียวกับ PO-receive handler) record ใน directory คือ source of
      // truth สำหรับชื่อ; email/department ถูก snapshot มาจากมัน แต่ยัง
      // override ได้ — ฟอร์มให้ operator แก้ contact detail ที่เก่าไปได้
      // ทันทีโดยไม่ต้องแก้ directory entry ทั้งหมด
      let employeeId: string | null = null;
      let employeeName = body.employeeName?.trim() ?? "";
      let employeeEmail = body.employeeEmail ?? null;
      let employeeDepartment = body.employeeDepartment ?? null;
      if (body.employeeId) {
        const employee = await getEmployee(pool, req.user!.orgId, body.employeeId);
        if (!employee) {
          res.status(400).json({ error: "employee not found" });
          return;
        }
        employeeId = employee.id;
        employeeName = employee.name;
        employeeEmail = body.employeeEmail ?? employee.email;
        employeeDepartment = body.employeeDepartment ?? employee.departmentName;
      }
      const handover = await createHandover(pool, req.user!.orgId, req.user!.username, {
        assetTag: body.assetTag,
        employeeId,
        employeeName,
        employeeEmail,
        employeeDepartment,
        handoverDate: body.handoverDate,
        conditionNotes: body.conditionNotes,
      });
      audit.info({ handoverId: handover.id, assetTag: handover.assetTag, employeeId, requestedBy: req.user!.username }, "handovers: created");
      await recordAuditEvent(pool, {
        actorUsername: req.user!.username,
        orgId: req.user!.orgId,
        action: "asset.handed_over",
        details: { assetTag: handover.assetTag, employeeName: handover.employeeName, employeeId },
      });
      res.status(201).json({ handover });
    } catch (err) {
      next(err);
    }
  });

  // Body เป็น optional (ว่างเปล่า {} ยังคงพฤติกรรมคลิกเดียวแบบเดิม) —
  // employeeSignature/eulaAccepted มาจาก modal "Accept & sign" ที่แสดงเมื่อ
  // org ตั้งค่า checkout_eula_text ไว้เท่านั้น
  router.post("/handovers/:id/acknowledge", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AcknowledgeHandoverSchema.parse(req.body ?? {});
      const handover = await acknowledgeHandover(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!handover) {
        res.status(404).json({ error: "handover not found" });
        return;
      }
      audit.info({ handoverId: handover.id, requestedBy: req.user!.username, signed: Boolean(body.employeeSignature) }, "handovers: acknowledged");
      res.json({ handover });
    } catch (err) {
      next(err);
    }
  });

  // --- Asset Management เฟส 2: check-in, history, models, custom fields, requests, licenses ---

  router.post("/assets/:assetTag/checkin", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const asset = await checkinAsset(pool, req.user!.orgId, assetTag);
      if (!asset) {
        res.status(404).json({ error: "asset not found" });
        return;
      }
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: checked in");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "asset.checked_in", details: { assetTag } });
      res.json({ asset });
    } catch (err) {
      next(err);
    }
  });

  router.get("/assets/:assetTag/history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const events = await getAssetHistory(pool, req.user!.orgId, req.params.assetTag ?? "");
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  router.get("/asset-custom-field-labels", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ labels: await getCustomFieldLabels(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/asset-custom-field-labels", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CustomFieldLabelsSchema.parse(req.body);
      const labels = await setCustomFieldLabels(pool, req.user!.orgId, {
        field1Label: body.field1Label ?? null,
        field2Label: body.field2Label ?? null,
        field3Label: body.field3Label ?? null,
        field4Label: body.field4Label ?? null,
        field5Label: body.field5Label ?? null,
      });
      audit.info({ requestedBy: req.user!.username }, "asset-custom-field-labels: updated");
      res.json({ labels });
    } catch (err) {
      next(err);
    }
  });

  router.get("/asset-models", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ assetModels: await listAssetModels(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-models", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AssetModelSchema.parse(req.body);
      const assetModel = await createAssetModel(pool, req.user!.orgId, body);
      audit.info({ assetModelId: assetModel.id, requestedBy: req.user!.username }, "asset-models: created");
      res.status(201).json({ assetModel });
    } catch (err) {
      next(err);
    }
  });

  router.put("/asset-models/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateAssetModelSchema.parse(req.body);
      const assetModel = await updateAssetModel(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!assetModel) {
        res.status(404).json({ error: "asset model not found" });
        return;
      }
      audit.info({ assetModelId: assetModel.id, requestedBy: req.user!.username }, "asset-models: updated");
      res.json({ assetModel });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/asset-models/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteAssetModel(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "asset model not found" });
        return;
      }
      audit.info({ assetModelId: req.params.id, requestedBy: req.user!.username }, "asset-models: deleted");
      res.status(204).end();
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This asset model was used to create assets and can't be deleted." });
        return;
      }
      next(err);
    }
  });

  router.get("/asset-requests", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ requests: await listAssetRequests(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  // ตั้งใจไม่มี requireRole gate — role ที่ authenticated แล้วทุกตัว (รวมถึง
  // viewer) request asset ที่ requestable ได้ เป็น write action เดียวที่
  // viewer ทำได้ในที่นี้ เพราะการ request ไม่ใช่การกระทำที่ทำลายข้อมูล (ดู
  // doc comment ของ migrations/0020)
  router.post("/asset-requests", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateAssetRequestSchema.parse(req.body);
      const request = await createAssetRequest(pool, req.user!.orgId, req.user!.username, body.assetTag, body.note ?? null);
      audit.info({ requestId: request.id, assetTag: body.assetTag, requestedBy: req.user!.username }, "asset-requests: created");
      res.status(201).json({ request });
    } catch (err) {
      next(err);
    }
  });

  // การ approve ยังทำ checkout จริง (assets + handover record) ใน handler
  // เดียวกันนี้ด้วย — ตามหลัก "cross-table orchestration อยู่ใน route ไม่ใช่
  // store" เดียวกับ POST /purchase-orders/:id/receive
  router.post("/asset-requests/:id/approve", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = ApproveAssetRequestSchema.parse(req.body ?? {});
      const request = await setAssetRequestStatus(pool, req.user!.orgId, req.params.id ?? "", "approved", req.user!.username);
      if (!request) {
        res.status(404).json({ error: "asset request not found" });
        return;
      }

      // requestedBy คือ login ของ OptiFleet ที่กด "Request" — audit trail
      // ของใครเป็นคนขอ พนักงานที่รับ asset จริงๆ เป็นอีกข้อเท็จจริงหนึ่งที่
      // ผู้ approve ใส่มาตรงนี้ เมื่อไม่ได้ใส่ (ยังไม่มี directory หรือคนขอ
      // ก็คือคนรับเองแต่ไม่ได้อยู่ใน directory) จะ fallback ไปเป็นพฤติกรรม
      // แบบก่อนมี directory เป๊ะๆ: username เป็น free text ทั้งสอง FK เป็น
      // null
      const employee = body.employeeId ? await getEmployee(pool, req.user!.orgId, body.employeeId) : null;
      if (body.employeeId && !employee) {
        res.status(400).json({ error: "employee not found" });
        return;
      }
      if (employee) await assignAssetRequestEmployee(pool, req.user!.orgId, request.id, employee.id);

      // ตั้งใจใช้ ?? undefined (ไม่ใช่ ?? null) บน field ที่ optional:
      // undefined แปลว่า "ไม่ต้องแตะ" ใน dynamic SET ของ updateAsset ดังนั้น
      // การ approve ที่ไม่มี employee จะไม่ล้าง contact info ที่ operator
      // อาจพิมพ์ไว้บน asset แล้ว
      await updateAsset(pool, req.user!.orgId, request.assetTag, {
        checkedOutTo: employee?.name ?? request.requestedBy,
        checkedOutToEmail: employee?.email ?? undefined,
        checkedOutToDepartment: employee?.departmentName ?? undefined,
        checkedOutToEmployeeId: employee?.id ?? undefined,
        checkoutDate: new Date().toISOString().slice(0, 10),
        status: "deployed",
      });
      await createHandover(pool, req.user!.orgId, req.user!.username, {
        assetTag: request.assetTag,
        employeeId: employee?.id ?? null,
        employeeName: employee?.name ?? request.requestedBy,
        employeeEmail: employee?.email ?? null,
        employeeDepartment: employee?.departmentName ?? null,
        conditionNotes: request.note ? `Self-service request: ${request.note}` : "Self-service request approval",
      });
      audit.info({ requestId: request.id, assetTag: request.assetTag, employeeId: employee?.id ?? null, requestedBy: req.user!.username }, "asset-requests: approved");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "asset_request.approved", details: { assetTag: request.assetTag, employeeId: employee?.id ?? null } });
      res.json({ request });
    } catch (err) {
      if (err instanceof InvalidAssetRequestTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  for (const [routeSuffix, toStatus] of [
    ["reject", "rejected"],
    ["cancel", "cancelled"],
  ] as const) {
    router.post(`/asset-requests/:id/${routeSuffix}`, requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const request = await setAssetRequestStatus(pool, req.user!.orgId, req.params.id ?? "", toStatus, req.user!.username);
        if (!request) {
          res.status(404).json({ error: "asset request not found" });
          return;
        }
        audit.info({ requestId: request.id, status: toStatus, requestedBy: req.user!.username }, `asset-requests: ${toStatus}`);
        res.json({ request });
      } catch (err) {
        if (err instanceof InvalidAssetRequestTransitionError) {
          res.status(409).json({ error: err.message });
          return;
        }
        next(err);
      }
    });
  }

  router.delete("/asset-requests/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteAssetRequest(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "asset request not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/licenses", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ licenses: await listLicenses(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/licenses", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = LicenseSchema.parse(req.body);
      const license = await createLicense(pool, req.user!.orgId, body);
      audit.info({ licenseId: license.id, requestedBy: req.user!.username }, "licenses: created");
      res.status(201).json({ license });
    } catch (err) {
      next(err);
    }
  });

  router.put("/licenses/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateLicenseSchema.parse(req.body);
      const license = await updateLicense(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!license) {
        res.status(404).json({ error: "license not found" });
        return;
      }
      audit.info({ licenseId: license.id, requestedBy: req.user!.username }, "licenses: updated");
      res.json({ license });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/licenses/:id", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteLicense(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "license not found" });
        return;
      }
      audit.info({ licenseId: req.params.id, requestedBy: req.user!.username }, "licenses: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/licenses/:id/assign", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AssignLicenseSchema.parse(req.body);
      const license = await assignLicense(pool, req.user!.orgId, req.params.id ?? "", body.assetTag);
      if (!license) {
        res.status(404).json({ error: "license not found" });
        return;
      }
      audit.info({ licenseId: license.id, assetTag: body.assetTag, requestedBy: req.user!.username }, "licenses: assigned");
      res.json({ license });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/licenses/:id/assignments/:assetTag", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await unassignLicense(pool, req.user!.orgId, req.params.id ?? "", req.params.assetTag ?? "");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // จำกัดด้วย self-or-platform-admin เหมือน route โลโก้ของ Track C — admin
  // ของ org เองตั้งค่าเงื่อนไข checkout ของตัวเอง
  router.get("/orgs/:id/checkout-eula", requireSelfOrPlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ checkoutEulaText: await getCheckoutEulaText(pool, req.params.id ?? "") });
    } catch (err) {
      next(err);
    }
  });

  router.put("/orgs/:id/checkout-eula", requireRole("admin"), requireSelfOrPlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CheckoutEulaSchema.parse(req.body);
      await setCheckoutEulaText(pool, req.params.id ?? "", body.checkoutEulaText);
      audit.info({ orgId: req.params.id, requestedBy: req.user!.username }, "orgs: checkout eula updated");
      res.json({ checkoutEulaText: body.checkoutEulaText });
    } catch (err) {
      next(err);
    }
  });

  // ป้อนข้อมูลให้ panel "needs attention" ของ dashboard และ daily digest job
  // (index.ts) — endpoint เดียว รูปแบบเดียวกันที่ใช้ร่วมกัน ไม่มี polling
  // logic แยกต่อหน้าจอ หน้าต่าง lookahead 30 วันสำหรับ
  // warranty/maintenance/licenses ตรงกับค่า default ของ
  // listUpcomingMaintenance/listAssetsWithExpiringWarranty/
  // listLicensesWithExpiring เองใน digest job
  router.get("/erp/alerts", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const withinDays = Math.min(Number(req.query.withinDays ?? 30), 365);
      const [expiringWarranties, upcomingMaintenance, expiringLicenses] = await Promise.all([
        listAssetsWithExpiringWarranty(pool, req.user!.orgId, withinDays),
        listUpcomingMaintenance(pool, req.user!.orgId, withinDays),
        listLicensesWithExpiring(pool, req.user!.orgId, withinDays),
      ]);
      res.json({ expiringWarranties, upcomingMaintenance, expiringLicenses });
    } catch (err) {
      next(err);
    }
  });

  // --- จบ Asset Management ERP -------------------------------------------

  // --- Fixed-Asset Accounting: chart of accounts, journal entries, fiscal periods, depreciation runs (บัญชีสินทรัพย์ถาวร) ---
  // การเขียนทุกจุดในนี้เป็น requireRole("admin") เท่านั้น — ข้อมูลบัญชีจริง
  // เข้มงวดกว่าการแบ่ง admin/it_support ของ ERP เชิงปฏิบัติการ — ยกเว้นการ
  // ทำเครื่องหมาย physical-count line ว่านับแล้ว เพราะ it_support คือคนที่
  // เดินไปสแกน asset จริงๆ

  router.get("/gl-accounts", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ accounts: await listGlAccounts(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/gl-accounts/ensure-defaults", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const accounts = await ensureDefaultAccounts(pool, req.user!.orgId);
      audit.info({ requestedBy: req.user!.username }, "gl-accounts: default accounts ensured");
      res.json({ accounts });
    } catch (err) {
      next(err);
    }
  });

  router.post("/gl-accounts", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = GlAccountSchema.parse(req.body);
      const account = await createGlAccount(pool, req.user!.orgId, body);
      audit.info({ accountId: account.id, requestedBy: req.user!.username }, "gl-accounts: created");
      res.status(201).json({ account });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "An account with that code already exists." });
        return;
      }
      next(err);
    }
  });

  router.put("/gl-accounts/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = UpdateGlAccountSchema.parse(req.body);
      const account = await updateGlAccount(pool, req.user!.orgId, req.params.id ?? "", body);
      if (!account) {
        res.status(404).json({ error: "account not found" });
        return;
      }
      audit.info({ accountId: account.id, requestedBy: req.user!.username }, "gl-accounts: updated");
      res.json({ account });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/gl-accounts/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteGlAccount(pool, req.user!.orgId, req.params.id ?? "");
      if (!deleted) {
        res.status(404).json({ error: "account not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      if (err instanceof SystemAccountProtectedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
        res.status(409).json({ error: "This account has journal entry lines posted against it and can't be deleted." });
        return;
      }
      next(err);
    }
  });

  router.get("/journal-entries", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const fiscalYear = req.query.fiscalYear ? Number(req.query.fiscalYear) : undefined;
      // sourceId ขับเคลื่อนแท็บ Accounting ของหน้า asset detail — ทุก entry
      // ที่ผูกกับ asset tag (acquisition/adjustment/retirement) บวกกับการ
      // reverse ของตัวไหนก็ตาม ดู doc comment ของ listJournalEntries
      const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId : undefined;
      res.json({ entries: await listJournalEntries(pool, req.user!.orgId, fiscalYear, sourceId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/journal-entries/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const entry = await getJournalEntry(pool, req.user!.orgId, req.params.id ?? "");
      if (!entry) {
        res.status(404).json({ error: "journal entry not found" });
        return;
      }
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  });

  router.post("/journal-entries/:id/reverse", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const reversal = await reverseJournalEntry(pool, req.user!.orgId, req.params.id ?? "", req.user!.username);
      audit.info({ originalEntryId: req.params.id, reversalEntryId: reversal.id, requestedBy: req.user!.username }, "journal-entries: reversed");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "journal_entry.reversed", details: { originalEntryId: req.params.id } });
      res.json({ entry: reversal });
    } catch (err) {
      if (err instanceof AlreadyReversedError || err instanceof FiscalYearClosedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/fiscal-periods", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ periods: await listFiscalPeriods(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/fiscal-periods/open", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CloseFiscalYearSchema.parse(req.body);
      const period = await openFiscalYear(pool, req.user!.orgId, body.fiscalYear);
      audit.info({ fiscalYear: body.fiscalYear, requestedBy: req.user!.username }, "fiscal-periods: opened");
      res.json({ period });
    } catch (err) {
      next(err);
    }
  });

  router.post("/fiscal-periods/close", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CloseFiscalYearSchema.parse(req.body);
      const period = await closeFiscalYear(pool, req.user!.orgId, body.fiscalYear, req.user!.username);
      audit.info({ fiscalYear: body.fiscalYear, requestedBy: req.user!.username }, "fiscal-periods: closed");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "fiscal_period.closed", details: { fiscalYear: body.fiscalYear } });
      res.json({ period });
    } catch (err) {
      if (err instanceof FiscalYearOrderError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/depreciation-runs", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ runs: await listDepreciationRuns(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/depreciation-runs/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const run = await getDepreciationRun(pool, req.user!.orgId, req.params.id ?? "");
      if (!run) {
        res.status(404).json({ error: "depreciation run not found" });
        return;
      }
      res.json({ run });
    } catch (err) {
      next(err);
    }
  });

  router.post("/depreciation-runs", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CalculateDepreciationRunSchema.parse(req.body);
      const run = await calculateDepreciationRun(pool, req.user!.orgId, { fiscalYear: body.fiscalYear, period: body.period ?? null, runDate: body.runDate }, req.user!.username);
      audit.info({ runId: run.id, requestedBy: req.user!.username }, "depreciation-runs: calculated");
      res.status(201).json({ run });
    } catch (err) {
      next(err);
    }
  });

  router.post("/depreciation-runs/:id/post", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { run, journalEntry } = await postDepreciationRun(pool, req.user!.orgId, req.params.id ?? "", req.user!.username);
      audit.info({ runId: run.id, journalEntryId: journalEntry.id, requestedBy: req.user!.username }, "depreciation-runs: posted");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "depreciation_run.posted", details: { runId: run.id, totalAmount: run.totalAmount } });
      res.json({ run, journalEntry });
    } catch (err) {
      if (err instanceof DepreciationRunNotDraftError || err instanceof EmptyDepreciationRunError || err instanceof FiscalYearClosedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.post("/depreciation-runs/:id/reverse", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const run = await reverseDepreciationRun(pool, req.user!.orgId, req.params.id ?? "", req.user!.username);
      audit.info({ runId: run.id, requestedBy: req.user!.username }, "depreciation-runs: reversed");
      res.json({ run });
    } catch (err) {
      if (err instanceof DepreciationRunNotPostedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // --- จบ Fixed-Asset Accounting ------------------------------------------

  // --- Asset lifecycle: transfers, physical counts, adjustments, retirements (วงจรชีวิตสินทรัพย์) ---

  router.get("/asset-transfers", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = typeof req.query.assetTag === "string" ? req.query.assetTag : undefined;
      res.json({ transfers: await listAssetTransfers(pool, req.user!.orgId, assetTag) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-transfers", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AssetTransferSchema.parse(req.body);
      const transfer = await createAssetTransfer(pool, req.user!.orgId, req.user!.username, body);
      audit.info({ transferId: transfer.id, assetTag: body.assetTag, requestedBy: req.user!.username }, "asset-transfers: created");
      res.status(201).json({ transfer });
    } catch (err) {
      next(err);
    }
  });

  router.get("/asset-count-cycles", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ cycles: await listCountCycles(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/asset-count-cycles/:id", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const cycle = await getCountCycle(pool, req.user!.orgId, req.params.id ?? "");
      if (!cycle) {
        res.status(404).json({ error: "count cycle not found" });
        return;
      }
      const lines = await listCountLines(pool, req.user!.orgId, req.params.id ?? "");
      res.json({ cycle, lines });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-count-cycles", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = StartCountCycleSchema.parse(req.body);
      const cycle = await startCountCycle(pool, req.user!.orgId, body.name, body.dueDate ?? null, req.user!.username);
      audit.info({ cycleId: cycle.id, requestedBy: req.user!.username }, "asset-count-cycles: started");
      res.status(201).json({ cycle });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-count-cycles/:id/lines/:lineId/count", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = MarkCountedSchema.parse(req.body);
      const line = await markCounted(pool, req.user!.orgId, req.params.lineId ?? "", { ...body, countedBy: req.user!.username });
      if (!line) {
        res.status(404).json({ error: "count line not found" });
        return;
      }
      res.json({ line });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-count-cycles/:id/close", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const cycle = await closeCountCycle(pool, req.user!.orgId, req.params.id ?? "");
      if (!cycle) {
        res.status(404).json({ error: "count cycle not found" });
        return;
      }
      audit.info({ cycleId: cycle.id, requestedBy: req.user!.username }, "asset-count-cycles: closed");
      res.json({ cycle });
    } catch (err) {
      next(err);
    }
  });

  router.get("/asset-adjustments", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = typeof req.query.assetTag === "string" ? req.query.assetTag : undefined;
      res.json({ adjustments: await listAssetAdjustments(pool, req.user!.orgId, assetTag) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-adjustments", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AssetAdjustmentSchema.parse(req.body);
      const adjustment = await createAdjustment(pool, req.user!.orgId, req.user!.username, body);
      audit.info({ adjustmentId: adjustment.id, assetTag: body.assetTag, requestedBy: req.user!.username }, "asset-adjustments: created");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "asset.adjusted", details: { assetTag: body.assetTag, fieldChanged: body.fieldChanged } });
      res.status(201).json({ adjustment });
    } catch (err) {
      if (err instanceof FiscalYearClosedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/asset-retirements", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ retirements: await listAssetRetirements(pool, req.user!.orgId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/asset-retirements", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AssetRetirementSchema.parse(req.body);
      const retirement = await retireAsset(pool, req.user!.orgId, req.user!.username, body);
      audit.info({ retirementId: retirement.id, assetTag: body.assetTag, requestedBy: req.user!.username }, "asset-retirements: created");
      await recordAuditEvent(pool, { actorUsername: req.user!.username, orgId: req.user!.orgId, action: "asset.retired", details: { assetTag: body.assetTag, reason: body.reason } });
      res.status(201).json({ retirement });
    } catch (err) {
      if (err instanceof AssetAlreadyRetiredError || err instanceof FiscalYearClosedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/assets/:assetTag/accumulated-depreciation", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const amount = await getAccumulatedDepreciation(pool, req.user!.orgId, req.params.assetTag ?? "");
      res.json({ accumulatedDepreciation: amount });
    } catch (err) {
      next(err);
    }
  });

  // --- จบ Asset lifecycle --------------------------------------------------

  router.post("/command", commandRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CommandRequestSchema.parse(req.body);
      const requestedBy = req.user!.username;

      let parsedCommand;
      try {
        parsedCommand = await parseNaturalLanguageCommand(body.text, deviceGroups.listScopes(req.user!.orgId), body.scope);
      } catch (err) {
        if (err instanceof ParseRefusedError) {
          audit.warn({ requestedBy, text: body.text, category: err.category }, "command: LLM refused to parse request");
          res.status(422).json({ error: "Request could not be processed by the language model's safety filters." });
          return;
        }
        if (err instanceof ParseFailedError) {
          audit.warn({ requestedBy, text: body.text }, "command: LLM produced an invalid tool call");
          res.status(422).json({ error: "Could not confidently map this request to a supported action — try rephrasing it more simply." });
          return;
        }
        if (err instanceof RateLimitedError) {
          audit.warn({ requestedBy, text: body.text, retryAfterSeconds: err.retryAfterSeconds }, "command: LLM provider rate-limited this request");
          if (err.retryAfterSeconds !== null) res.set("Retry-After", String(err.retryAfterSeconds));
          res.status(429).json({
            error: err.retryAfterSeconds !== null
              ? `The AI is temporarily out of requests for today — try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`
              : "The AI is temporarily out of requests for today — try again later.",
          });
          return;
        }
        throw err;
      }

      // การจัดการ organization/user — pipeline ที่แยกต่างหากอย่างสมบูรณ์จาก
      // ทุกอย่างด้านล่าง (ไม่มี device/scope/dispatch เข้ามาเกี่ยวข้องเลย)
      // ดู doc comment ของ security/adminGuardrail.ts เองสำหรับ permission
      // model และทำไม action ที่สร้างของใหม่ถึงไม่เคย execute แบบไม่เห็นหน้า
      if (parsedCommand.kind === "admin") {
        const isPlatformAdmin = req.user!.role === "admin" && req.user!.orgId === PLATFORM_ORG_ID;
        const verdict = await evaluateAdminIntent(parsedCommand.parsed, {
          role: req.user!.role,
          orgId: req.user!.orgId,
          isPlatformAdmin,
          pool,
        });

        if (verdict.verdict === "blocked") {
          res.status(422).json({ error: verdict.reason });
          return;
        }

        if (verdict.verdict === "admin_form") {
          res.status(200).json({
            status: "admin_form",
            formAction: verdict.formAction,
            prefill: verdict.prefill,
            reasoning: parsedCommand.parsed.reasoning,
          });
          return;
        }

        if (verdict.verdict === "needs_confirmation") {
          const action = pendingAdmin.create({
            resolved: verdict.resolved,
            reason: verdict.reason,
            requestedBy,
            originalText: body.text,
          });
          res.status(202).json({
            status: "needs_confirmation",
            kind: "admin",
            pendingId: action.id,
            reason: verdict.reason,
            resolved: verdict.resolved,
            expiresInSeconds: 300,
            reasoning: parsedCommand.parsed.reasoning,
          });
          return;
        }

        // verdict.verdict === "allowed" — เป็น generate_installer เท่านั้น
        // เสมอ (admin action เดียวที่ไม่มีอะไรทำลายข้อมูลที่ต้องยืนยัน)
        if (verdict.resolved.action === "generate_installer") {
          const { orgId: installerOrgId, orgName, subdomain } = verdict.resolved;
          res.status(200).json({
            status: "admin_result",
            resultAction: "generate_installer",
            installerOrgId,
            orgName,
            subdomain,
            ownOrg: installerOrgId === req.user!.orgId,
            reasoning: parsedCommand.parsed.reasoning,
          });
          return;
        }
        res.status(500).json({ error: "unexpected admin verdict" });
        return;
      }

      // Asset Management ERP — รูปแบบ "pipeline ที่แยกต่างหากอย่างสมบูรณ์"
      // เดียวกับ branch admin ด้านบน ดู doc comment ของ
      // security/erpGuardrail.ts
      if (parsedCommand.kind === "erp") {
        const verdict = await evaluateErpIntent(parsedCommand.parsed, {
          role: req.user!.role,
          orgId: req.user!.orgId,
          pool,
        });

        if (verdict.verdict === "blocked") {
          res.status(422).json({ error: verdict.reason });
          return;
        }

        if (verdict.verdict === "admin_form") {
          res.status(200).json({
            status: "erp_form",
            formAction: verdict.formAction,
            prefill: verdict.prefill,
            reasoning: parsedCommand.parsed.reasoning,
          });
          return;
        }

        // verdict.verdict === "needs_confirmation"
        const action = pendingErp.create({
          resolved: verdict.resolved,
          reason: verdict.reason,
          requestedBy,
          originalText: body.text,
        });
        res.status(202).json({
          status: "needs_confirmation",
          kind: "erp",
          pendingId: action.id,
          reason: verdict.reason,
          resolved: verdict.resolved,
          expiresInSeconds: 300,
          reasoning: parsedCommand.parsed.reasoning,
        });
        return;
      }

      let parsed = parsedCommand.parsed;

      // Operator เลือกอุปกรณ์เฉพาะเจาะจงใน UI แล้ว — เป็นสัญญาณที่แข็งแรง
      // กว่าอะไรก็ตามที่ model ดึงมาจาก free text จึงชนะไปเลย แทนที่จะเป็น
      // แค่ "อีกหนึ่งเสียง" ควบคู่กับการเดาของ model
      if (body.scope) {
        parsed = { ...parsed, scope: body.scope };
      }

      // query_info ไม่เคย dispatch อะไรเลย จึงไม่เคยเข้าใกล้ guardrail —
      // งานทั้งหมดของ evaluateParsedIntent คือตัดสินใจว่าจะ dispatch
      // CommandAction หรือไม่ ซึ่งการอ่านล้วนๆ ไม่มีสิ่งนั้น การ resolve
      // scope ยังใช้อยู่ (อุปกรณ์ที่ไม่รู้จักก็ยังไม่รู้จัก) และต้องการ
      // อุปกรณ์เดียวเป๊ะๆ เสมอ: การตอบ "IP ของนายคืออะไร" แบบรวมทั้งกลุ่ม
      // ไม่ใช่ประโยคเดียว
      if (parsed.action === "query_info") {
        const targets = deviceGroups.resolve(req.user!.orgId, parsed.scope);
        if (targets.length === 0) {
          audit.warn({ requestedBy, text: body.text, scope: parsed.scope }, "query_info: unknown scope");
          res.status(422).json({
            error: `Unknown device/group scope "${parsed.scope}". Known scopes: ${deviceGroups.listScopes(req.user!.orgId).join(", ")}`,
            parsed,
          });
          return;
        }
        if (targets.length > 1) {
          res.status(422).json({
            error: "query_info only answers about one device at a time — name a specific device, not a group.",
            parsed,
          });
          return;
        }
        const agentId = targets[0]!;
        const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
        if (!snapshot) {
          res.status(404).json({ error: `No telemetry available for ${agentId} yet (offline, or hasn't reported since it connected).` });
          return;
        }
        const result = await answerDeviceQuery({ deviceId: agentId, question: body.text, topicHint: parsed.target, snapshot });
        audit.info({ requestedBy, agentId, question: body.text, result }, "query_info: answered");
        res.json({ status: "answered", agentId, answerable: result.answerable, answer: result.answer, reasoning: parsed.reasoning });
        return;
      }

      // Model ไม่มั่นใจพอที่จะ map เข้ากับ action ที่รองรับได้เฉพาะเจาะจง —
      // แทนที่จะตันด้วย "ขอโทษ ไม่เข้าใจ" ให้ fallback ไปที่ path ตอบข้อมูล
      // สดแบบเดียวกับที่ query_info ใช้ ตราบใดที่มีอุปกรณ์จริงที่ระบุได้และ
      // กำลังรายงานอยู่พอดีหนึ่งตัว operator ยังได้ *อะไรบางอย่าง* ที่เป็น
      // ประโยชน์ (สถานะปัจจุบันจริงของอุปกรณ์) แทนที่จะไม่ได้อะไรเลย แม้ว่า
      // request เองจะกำกวม/ผิดรูปแบบเกินกว่าจะ execute เป็นคำสั่งเฉพาะเจาะจง
      // ได้ก็ตาม action ที่ทำลายข้อมูลไม่มีความเสี่ยงเลยตรงนี้: ทางนี้ผลิตแค่
      // คำตอบแบบอ่านอย่างเดียวเสมอ เหมือนกับ query_info — ไม่มีทางหลุดไป
      // dispatch อะไรได้เลย
      if (parsed.action === "unsupported") {
        const fallbackTargets = deviceGroups.resolve(req.user!.orgId, parsed.scope);
        if (fallbackTargets.length === 1) {
          const agentId = fallbackTargets[0]!;
          const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
          if (snapshot) {
            const result = await answerDeviceQuery({
              deviceId: agentId,
              question: body.text,
              topicHint: parsed.target || parsed.reasoning,
              snapshot,
            });
            audit.info({ requestedBy, agentId, question: body.text, result }, "command: unsupported action, fell back to live device data");
            res.json({
              status: "answered",
              agentId,
              answerable: result.answerable,
              answer: result.answer,
              reasoning: parsed.reasoning,
              fallback: true,
            });
            return;
          }
        }
      }

      // ทุกอย่างก่อนจุดนี้ (query_info, fallback unsupported→read-only) เป็น
      // แบบอ่านอย่างเดียวและเปิดให้ทุก role ใช้ได้ อะไรก็ตามที่มาถึงตรงนี้
      // คือ action ที่ dispatch จริง ซึ่ง 'viewer' ทำไม่ได้เลย — เช็คตรงนี้
      // แทนที่จะใช้ requireRole กับทั้ง route เพราะจะบล็อกคำถามแบบอ่าน
      // อย่างเดียวของ viewer ไปด้วย ซึ่ง endpoint เดียวกันนี้จัดการอยู่
      if (req.user!.role === "viewer") {
        audit.warn({ requestedBy, text: body.text, action: parsed.action }, "command: blocked, viewer role cannot dispatch");
        res.status(403).json({ error: "Your account is read-only and cannot dispatch commands." });
        return;
      }

      const verdict = evaluateParsedIntent(parsed, {
        orgId: req.user!.orgId,
        deviceGroups,
        enableRunScriptDispatch: cfg.enableRunScriptDispatch,
        massActionThreshold: MASS_ACTION_THRESHOLD,
      });

      if (verdict.verdict === "blocked") {
        res.status(422).json({ error: verdict.reason, parsed });
        return;
      }

      if (verdict.verdict === "needs_confirmation") {
        const action = pending.create({
          resolved: verdict.resolved,
          targets: verdict.targets,
          reason: verdict.reason,
          requestedBy,
          originalText: body.text,
        });
        res.status(202).json({
          status: "needs_confirmation",
          pendingId: action.id,
          reason: verdict.reason,
          resolved: verdict.resolved,
          targets: verdict.targets,
          expiresInSeconds: 300,
          reasoning: parsed.reasoning,
        });
        return;
      }

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(req.user!.orgId, verdict.resolved, verdict.targets, registry, history, hmacSecret, requestedBy, body.text);
      res.status(200).json({ status: "dispatched", resolved: verdict.resolved, results, reasoning: parsed.reasoning });
    } catch (err) {
      next(err);
    }
  });

  router.post("/command/:id/confirm", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const confirmedBy = req.user!.username;
      const pendingId = req.params.id ?? "";

      // ลองก่อนเป็นอันดับแรก: pending ID ของ admin และ device ถูกสร้างจาก
      // PendingActionStore instance ที่แยกกันโดยสิ้นเชิงสองตัว (ดู
      // pendingActions.ts) ดังนั้น ID จริงจะมีอยู่แค่ในตัวใดตัวหนึ่งเท่านั้น
      const adminAction = pendingAdmin.take(pendingId);
      if (adminAction) {
        audit.info(
          { pendingId, originalRequestedBy: adminAction.requestedBy, confirmedBy, resolved: adminAction.resolved },
          "command: human confirmed pending admin action, executing",
        );
        const message = await executeAdminAction(pool, adminAction.resolved, confirmedBy, orgCredentials);
        res.status(200).json({ status: "admin_result", message });
        return;
      }

      const erpAction = pendingErp.take(pendingId);
      if (erpAction) {
        audit.info(
          { pendingId, originalRequestedBy: erpAction.requestedBy, confirmedBy, resolved: erpAction.resolved },
          "command: human confirmed pending erp action, executing",
        );
        const message = await executeErpAction(pool, req.user!.orgId, erpAction.resolved, confirmedBy);
        res.status(200).json({ status: "admin_result", message });
        return;
      }

      const action = pending.take(pendingId);
      if (!action) {
        res.status(404).json({ error: "pending action not found — it may have expired (5 min TTL) or already been confirmed." });
        return;
      }

      audit.info(
        { pendingId, originalRequestedBy: action.requestedBy, confirmedBy, resolved: action.resolved, targets: action.targets },
        "command: human confirmed pending action, dispatching",
      );

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(req.user!.orgId, action.resolved, action.targets, registry, history, hmacSecret, confirmedBy, action.originalText);
      res.status(200).json({ status: "dispatched", resolved: action.resolved, results });
    } catch (err) {
      next(err);
    }
  });

  // ควบคุม process โดยตรงสำหรับปุ่ม "Force Close" ของ Task Manager UI —
  // ตั้งใจข้าม LLM ไปเลย (UI รู้อยู่แล้วว่าต้องการอะไรเป๊ะๆ) แต่ยังผ่าน
  // signed-dispatch path เดียวกับคำสั่งอื่นทุกตัว จึงถูก audit และบันทึกลง
  // history เหมือนกันทุกประการ
  router.post("/agents/:id/kill-process", requireRole("admin", "it_support"), (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const body = KillProcessRequestSchema.parse(req.body);
      const params = body.pid !== undefined ? { pid: String(body.pid) } : { name: body.name! };

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(
        req.user!.orgId,
        { action: "kill_process", params },
        [agentId],
        registry,
        history,
        hmacSecret,
        req.user!.username,
      );
      res.status(200).json({ status: "dispatched", results });
    } catch (err) {
      next(err);
    }
  });

  // Path เดียวที่ dispatch run_script ได้อย่างชัดเจนและผ่านการตรวจสอบจาก
  // มนุษย์ ที่ resolveAction ของ guardrail.ts อ้างถึงตอนบล็อกไม่ให้
  // run_script ถูก infer โดย LLM parser เลย (ดู comment "run_script
  // cannot be dispatched from a natural-language request" ของไฟล์นั้น) —
  // เนื้อหา script มาจาก request ของ admin ที่ authenticated แล้วตรงๆ
  // เป๊ะๆ ไม่เคยมาจาก free text ที่ model ตีความ ยังผ่าน server flag
  // OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH เดียวกับที่ path ภาษาธรรมชาติเช็ค
  // (ปิด flag นั้นก็ปิด path นี้ไปด้วย) ยังถูกสแกนด้วย blacklist tripwire
  // เดียวกับที่ template uninstall ที่ตรวจสอบแล้วต้องผ่าน และเป็น
  // admin-only ไม่ใช่ admin+it_support — นี่คือ action ที่เสี่ยงสูงที่สุด
  // ตัวเดียวที่ fleet dispatch ได้ (script SYSTEM/root ที่เป็นอะไรก็ได้)
  // และท้ายที่สุดยังต้องการ run_script allowlist entry ในเครื่องของ agent
  // target เอง + environment variable OPTIFLEET_ENABLE_RUN_SCRIPT ซึ่งเป็น
  // opt-in แยกต่างหากตาม validate() ของ internal/config/config.go
  router.post("/agents/:id/run-script", requireRole("admin"), (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (!cfg.enableRunScriptDispatch) {
        res.status(403).json({ error: "run_script dispatch is disabled on this server (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH)." });
        return;
      }
      const agentId = req.params.id ?? "";
      const body = RunScriptRequestSchema.parse(req.body);

      const hit = scanForBlacklistedContent(body.script);
      if (hit) {
        audit.warn({ agentId, requestedBy: req.user!.username, reason: hit.reason }, "run-script: blocked by blacklist tripwire");
        res.status(422).json({ error: `Script blocked: matches a known-destructive pattern (${hit.reason}).` });
        return;
      }

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(
        req.user!.orgId,
        { action: "run_script", params: { script: body.script } },
        [agentId],
        registry,
        history,
        hmacSecret,
        req.user!.username,
      );
      audit.info({ agentId, requestedBy: req.user!.username }, "run-script: dispatched");
      res.status(200).json({ status: "dispatched", results });
    } catch (err) {
      next(err);
    }
  });

  // รองรับ path "upload your own installer" ของหน้า Software Deploy — ไฟล์
  // .exe/.msi ที่ admin เป็นคนให้มาเองที่ operator ต้องการ push ไปยัง
  // อุปกรณ์ ตรงข้ามกับ Ninite silent-install URL เก็บไว้ใต้
  // cfg.customInstallersDir พร้อม prefix เป็น random id (ไม่เคยเป็น path
  // ตรงๆ ของ client และถูกตัดเหลือแค่ basename) ดังนั้นตรงนี้ไม่มีทางเขียน
  // ออกนอกโฟลเดอร์นั้นได้เลย id ที่อัปโหลดจะมีประโยชน์ก็ต่อเมื่อจับคู่กับ
  // endpoint run-script ด้านบน — route นี้เพียงลำพังไม่ได้ติดตั้งอะไรเลย
  // express.raw() (ไม่ใช่ express.json() ของทั้ง router) ผูกไว้กับ route
  // เดียวนี้เท่านั้น: ไฟล์ installer หลายร้อย MB ไม่ใช่ JSON และการให้ route
  // อื่นทุกตัวมีเพดานขนาด body เดียวกันนี้จะเป็นช่องโหว่ DoS ที่ไม่จำเป็น
  router.post(
    "/software-uploads",
    requireRole("admin"),
    uploadRateLimiter,
    express.raw({ type: () => true, limit: "300mb" }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "no file body received" });
          return;
        }
        const rawName = String(req.query.filename ?? "installer.bin");
        const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, "_") || "installer.bin";
        const id = `${randomUUID()}-${safeName}`;

        // Subdirectory แยกต่อ org ไม่ใช่โฟลเดอร์แบนที่แชร์กัน — GET
        // /agent-download/custom/:id (ws/server.ts) มองเข้าไปแค่ใน
        // subdirectory ของ org ที่ request เข้ามาเท่านั้น ดังนั้นการอัปโหลด
        // ของ org หนึ่งจะเข้าถึงไม่ได้จากอีก org แม้ว่า random id ของมันจะ
        // รั่วไหลออกไปด้วยเหตุผลบางอย่างก็ตาม
        const orgUploadsDir = path.join(cfg.customInstallersDir, req.user!.orgId);
        const currentUsage = await getDirSize(orgUploadsDir);
        if (currentUsage + req.body.length > cfg.customInstallersMaxBytesPerOrg) {
          res.status(413).json({
            error: `Storage limit reached (${Math.round(cfg.customInstallersMaxBytesPerOrg / (1024 * 1024))}MB per organization). Delete old uploads before adding more.`,
          });
          return;
        }
        await mkdir(orgUploadsDir, { recursive: true });
        await writeFile(path.join(orgUploadsDir, id), req.body);

        audit.info(
          { requestedBy: req.user!.username, id, bytes: req.body.length },
          "software-uploads: installer stored",
        );
        // downloadUrl/agentAuthToken ให้ dashboard สร้าง run_script body
        // ที่ดึงไฟล์นี้กลับลงมาบนอุปกรณ์ target ได้ — เป็น agent token ของ
        // org ผู้เรียกเอง (server/src/orgs/orgCredentials.ts —
        // /agent-download/custom/:id ตอนนี้เช็ค token ต่อ org ไม่ใช่ secret
        // เดียวทั้ง fleet) ตัวเดียวกับที่ฝังอยู่ใน install.ps1 ของ org นั้น
        // อยู่แล้ว ไม่ใช่ secret ใหม่ที่ endpoint นี้เปิดเผยออกมา
        const { rows: orgRows } = await pool.query<{ agent_auth_token: string }>(
          `SELECT agent_auth_token FROM organizations WHERE id = $1`,
          [req.user!.orgId],
        );
        res.status(201).json({
          id,
          filename: safeName,
          bytes: req.body.length,
          downloadUrl: `https://${cfg.ws.publicHost}/agent-download/custom/${encodeURIComponent(id)}`,
          agentAuthToken: orgRows[0]?.agent_auth_token ?? "",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // รองรับหน้า Agent Updates: build ทุกตัวที่เคย push (AgentBuildRegistry ของ
  // agentBuilds.ts) ตัวไหน active (สิ่งที่ fleet converge เข้าหา — ดู
  // needsUpdate ของ ws/registry.ts) และมุมมอง pending-update ต่อ agent ที่
  // derive จาก version ที่ agent ที่เชื่อมต่ออยู่แต่ละตัวรายงานเอง
  router.get("/agent-builds", requireRole("admin"), (req: AuthedRequest, res: Response) => {
    const activeVersion = agentBuildRegistry.activeVersion;
    const agents = registry
      .listAll()
      .filter((a) => a.orgId === req.user!.orgId)
      .map((a) => ({
        agentId: a.agentId,
        status: a.status,
        version: a.version,
        updateStatus: !a.version ? "unknown" : activeVersion && a.version === activeVersion ? "up_to_date" : "pending",
      }));
    res.json({ activeVersion, builds: agentBuildRegistry.list(), agents });
  });

  // อัปโหลด agent build ใหม่ภายใต้ version ที่ระบุ — pattern raw-body
  // เดียวกับ POST /software-uploads ด้านบน ด้วยเหตุผลเดียวกัน (binary
  // หลาย MB ไม่ใช่ JSON) การเก็บไว้ตรงนี้ไม่ได้ activate มันเลย — เป็นขั้น
  // ตอนแยกที่ชัดเจนด้านล่าง ดังนั้นการอัปโหลดที่พังจะถูกตรวจสอบ/ลบด้วยมือ
  // บนดิสก์ได้ก่อนที่จะถูกเสนอให้ agent ตัวไหนเลย
  router.post(
    "/agent-builds",
    requireRole("admin"),
    express.raw({ type: () => true, limit: "100mb" }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "no file body received" });
          return;
        }
        const version = String(req.query.version ?? "").trim();
        if (!version) {
          res.status(400).json({ error: "version query param is required" });
          return;
        }
        const info = await agentBuildRegistry.addBuild(version, req.body);
        audit.info({ requestedBy: req.user!.username, version, sha256: info.sha256 }, "agent-builds: new build uploaded");
        res.status(201).json({ build: info });
      } catch (err) {
        next(err);
      }
    },
  );

  // Rollback (ไปเวอร์ชันเก่า) และ roll-forward (ไปเวอร์ชันล่าสุด) คือการ
  // เรียกแบบเดียวกัน — ดู doc comment ของ AgentBuildRegistry.setActive มีผล
  // ตั้งแต่ heartbeat ครั้งถัดไปของ agent ที่เชื่อมต่ออยู่ทุกตัว ไม่ต้อง
  // restart เซิร์ฟเวอร์
  router.post(
    "/agent-builds/:version/activate",
    requireRole("admin"),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const version = req.params.version ?? "";
        await agentBuildRegistry.setActive(version);
        audit.info({ requestedBy: req.user!.username, version }, "agent-builds: active version changed");
        res.json({ activeVersion: version });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("unknown build version")) {
          res.status(404).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // คำแนะนำการแก้ไขจาก AI สำหรับตัวช่วยคลิกเดียวของ process manager คืนค่า
  // แค่คำแนะนำเท่านั้น — ไม่มีอะไรถูก apply ตรงนี้ frontend แสดงคำแนะนำและให้
  // operator คลิกต่อไปยัง endpoint kill-process ด้านบนเองถ้าเห็นด้วย
  router.post("/agents/:id/suggest-remediation", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const body = SuggestRemediationRequestSchema.parse(req.body);
      const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
      const proc = snapshot?.top_processes.find((p) => p.pid === body.pid);
      if (!proc) {
        res.status(404).json({ error: "process not found in the device's most recent telemetry snapshot" });
        return;
      }

      const suggestion = await suggestRemediation({
        deviceId: agentId,
        processName: proc.name,
        pid: proc.pid,
        cpuPercent: proc.cpu_percent,
        memMb: proc.mem_mb,
      });
      res.json({ suggestion, process: proc });
    } catch (err) {
      next(err);
    }
  });

  // รองรับหน้า Downloads ของ dashboard — admin/it_support ของแต่ละ org
  // ดาวน์โหลด installer ของ org ตัวเอง (req.user!.orgId, ไม่มี :id param
  // ต่างจาก GET /orgs/:id/installer ด้านบนที่ platform-admin เท่านั้นที่ใช้
  // ได้และเจาะจง org ไหนก็ได้) เดิมทีเสิร์ฟ zip ที่ build ไว้ล่วงหน้าไฟล์
  // เดียวจากดิสก์ (cfg.agentInstallerPath) ที่มี agent_auth_token/
  // agent_hmac_secret จริงของ legacy org ดั้งเดิม hardcode ไว้ใน install.ps1
  // — เข้าถึงได้จาก admin/it_support ของทุก tenant โดยไม่มีการเช็ค org เลย
  // ทำให้ลูกค้ารายไหนก็ได้ดึง credential จริงของ legacy org ออกมาได้ และ
  // อุปกรณ์ที่ติดตั้งจากไฟล์นั้นก็จะ enroll เข้า legacy org แบบเงียบๆ แทนที่
  // จะเป็น org ที่ดาวน์โหลดจริง แก้แล้วโดยให้ build zip สดใหม่ต่อ org ด้วย
  // วิธีเดียวกับที่ route platform-admin ทำ (streamOrgInstallerZip +
  // credential ของ org นี้เองจาก getOrganizationCredentials)
  router.get("/downloads/agent-installer", requireRole("admin", "it_support"), installerRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const found = await getOrganizationCredentials(pool, req.user!.orgId);
      if (!found) {
        res.status(404).json({ error: "organization not found" });
        return;
      }
      const active = agentBuildRegistry.getActive();
      if (!active) {
        res.status(409).json({ error: "No agent build has been uploaded yet — nothing to package." });
        return;
      }
      audit.info({ requestedBy: req.user!.username, orgId: req.user!.orgId }, "downloads: agent installer generated");
      streamOrgInstallerZip(res, { templateDir: cfg.agentInstallerTemplateDir, agentExePath: active.exePath }, found.org.subdomain, found.agentAuthToken, found.agentHmacSecret);
    } catch (err) {
      next(err);
    }
  });

  // Error handler กลาง: validation error -> 400 อย่างอื่นทั้งหมด -> 500
  // โดย log รายละเอียดไว้ แต่ไม่ echo กลับไปให้ client
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid request", details: err.issues });
      return;
    }
    log.error({ err }, "api: unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  return router;
}
