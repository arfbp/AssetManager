// การแปลภาษาของ UI ส่วน chrome แบบขั้นต่ำ — ตั้งใจจำกัดขอบเขตแค่ sidebar nav
// กับ header ด้านบน (ส่วนที่ทุกหน้าใช้ร่วมกันผ่าน AppShell) ไม่รวมเนื้อหาส่วนอื่น
// ของแต่ละหน้า รูปแบบเหมือนกับ src/components/theme/ThemeToggle.tsx คือเก็บค่า
// preference ไว้ใน localStorage ธรรมดา ไม่มี context provider หรือ locale
// ที่ผูกกับ routing — เอาแบบง่ายที่สุดที่ใช้ได้กับแค่ "ส่วน shell"
//
// เรื่องนี้แยกจากการรองรับหลายภาษาของ AI command parser เอง
// (server/src/llm/actionParser.ts) — อันนั้นคือโมเดลเข้าใจสิ่งที่ operator พิมพ์
// มาไม่ว่าภาษาไหนก็ตาม ส่วนที่นี่คือ label แบบ static ของ UI เองที่มีให้ใช้ในภาษา
// เดียวกับที่ operator ของ fleet นี้ใช้งานจริง
export type Locale = "en" | "th" | "zh";

export const LOCALES: Locale[] = ["en", "th", "zh"];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  th: "ไทย",
  zh: "中文",
};

interface ShellStrings {
  dashboard: string;
  devices: string;
  aiConsole: string;
  liveTracking: string;
  assetRegistry: string;
  employees: string;
  vendors: string;
  purchaseOrders: string;
  assetModels: string;
  maintenance: string;
  handovers: string;
  assetRequests: string;
  licenses: string;
  assetTransfers: string;
  assetCounts: string;
  assetAdjustments: string;
  assetRetirements: string;
  glAccounts: string;
  journalEntries: string;
  fiscalPeriods: string;
  depreciationRuns: string;
  downloads: string;
  softwareDeploy: string;
  agentUpdates: string;
  uninstallSoftware: string;
  users: string;
  orgSettings: string;
  organizations: string;
  auditLog: string;
  navSectionFleet: string;
  navSectionErp: string;
  navSectionAccounting: string;
  navSectionDeploy: string;
  navSectionAdministration: string;
  navSectionPlatform: string;
  backofficeConsole: string;
  searchPlaceholder: string;
  signedIn: string;
  signedInAs: string;
  logOut: string;
  needsAttention: string;
}

export const SHELL_STRINGS: Record<Locale, ShellStrings> = {
  en: {
    dashboard: "Dashboard",
    devices: "Devices",
    aiConsole: "AI Console",
    liveTracking: "Live Tracking",
    assetRegistry: "Asset registry",
    employees: "Employees",
    vendors: "Vendors",
    purchaseOrders: "Purchase Orders",
    assetModels: "Asset Models",
    maintenance: "Maintenance",
    handovers: "Handovers",
    assetRequests: "Requests",
    licenses: "Licenses",
    assetTransfers: "Transfers",
    assetCounts: "Physical Counts",
    assetAdjustments: "Adjustments",
    assetRetirements: "Retirements",
    glAccounts: "Chart of Accounts",
    journalEntries: "Journal Entries",
    fiscalPeriods: "Fiscal Periods",
    depreciationRuns: "Depreciation Runs",
    downloads: "Downloads",
    softwareDeploy: "Software Deploy",
    agentUpdates: "Agent Updates",
    uninstallSoftware: "Uninstall Software",
    users: "Users",
    orgSettings: "Branding",
    organizations: "Organizations",
    auditLog: "Audit Log",
    navSectionFleet: "Fleet",
    navSectionErp: "Asset Management",
    navSectionAccounting: "Accounting",
    navSectionDeploy: "Deploy & Maintain",
    navSectionAdministration: "Administration",
    navSectionPlatform: "Platform",
    backofficeConsole: "Backoffice Console",
    searchPlaceholder: "Search devices by name…",
    signedIn: "Signed in",
    signedInAs: "Signed in as",
    logOut: "Log out",
    needsAttention: "Needs attention",
  },
  th: {
    dashboard: "แดชบอร์ด",
    devices: "อุปกรณ์",
    aiConsole: "คอนโซล AI",
    liveTracking: "ติดตามอุปกรณ์",
    assetRegistry: "ทะเบียนทรัพย์สิน",
    employees: "ทะเบียนพนักงาน",
    vendors: "ผู้จำหน่าย",
    purchaseOrders: "ใบสั่งซื้อ",
    assetModels: "รุ่นทรัพย์สิน",
    maintenance: "งานซ่อมบำรุง",
    handovers: "การส่งมอบ",
    assetRequests: "คำขอเบิก",
    licenses: "ใบอนุญาตซอฟต์แวร์",
    assetTransfers: "การโอนย้าย",
    assetCounts: "ตรวจนับทรัพย์สิน",
    assetAdjustments: "การปรับปรุงรายการ",
    assetRetirements: "การตัดจำหน่าย",
    glAccounts: "ผังบัญชี",
    journalEntries: "สมุดรายวัน",
    fiscalPeriods: "รอบบัญชี",
    depreciationRuns: "รอบคำนวณค่าเสื่อมราคา",
    downloads: "ดาวน์โหลด",
    softwareDeploy: "ติดตั้งซอฟต์แวร์",
    agentUpdates: "อัปเดตเอเจนต์",
    uninstallSoftware: "ถอนโปรแกรม",
    users: "ผู้ใช้งาน",
    orgSettings: "แบรนด์องค์กร",
    organizations: "องค์กร",
    auditLog: "ประวัติการใช้งาน",
    navSectionFleet: "ฟลีต",
    navSectionErp: "จัดการทรัพย์สิน",
    navSectionAccounting: "บัญชี",
    navSectionDeploy: "ติดตั้ง & บำรุงรักษา",
    navSectionAdministration: "การจัดการ",
    navSectionPlatform: "แพลตฟอร์ม",
    backofficeConsole: "ระบบหลังบ้าน",
    searchPlaceholder: "ค้นหาอุปกรณ์ตามชื่อ…",
    signedIn: "เข้าสู่ระบบแล้ว",
    signedInAs: "เข้าสู่ระบบในชื่อ",
    logOut: "ออกจากระบบ",
    needsAttention: "ต้องการความสนใจ",
  },
  zh: {
    dashboard: "仪表盘",
    devices: "设备",
    aiConsole: "AI 控制台",
    liveTracking: "实时追踪",
    assetRegistry: "资产登记",
    employees: "员工",
    vendors: "供应商",
    purchaseOrders: "采购订单",
    assetModels: "资产型号",
    maintenance: "维护保养",
    handovers: "资产交接",
    assetRequests: "领用申请",
    licenses: "软件许可",
    assetTransfers: "资产调拨",
    assetCounts: "资产盘点",
    assetAdjustments: "资产调整",
    assetRetirements: "资产报废",
    glAccounts: "会计科目表",
    journalEntries: "日记账分录",
    fiscalPeriods: "会计期间",
    depreciationRuns: "折旧计提",
    downloads: "下载",
    softwareDeploy: "软件部署",
    agentUpdates: "代理更新",
    uninstallSoftware: "卸载软件",
    users: "用户",
    orgSettings: "品牌设置",
    organizations: "组织",
    auditLog: "审计日志",
    navSectionFleet: "车队",
    navSectionErp: "资产管理",
    navSectionAccounting: "会计",
    navSectionDeploy: "部署与维护",
    navSectionAdministration: "管理",
    navSectionPlatform: "平台",
    backofficeConsole: "后台管理系统",
    searchPlaceholder: "按名称搜索设备…",
    signedIn: "已登录",
    signedInAs: "当前登录",
    logOut: "退出登录",
    needsAttention: "需要注意",
  },
};

const STORAGE_KEY = "optifleet-locale";

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "th" || stored === "zh" || stored === "en" ? stored : "en";
}

export function setStoredLocale(locale: Locale): void {
  window.localStorage.setItem(STORAGE_KEY, locale);
}
