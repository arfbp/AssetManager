// Minimal UI-chrome translation — scoped deliberately to the sidebar nav and
// top header (the parts every page shares via AppShell), not the rest of
// each page's own content. Mirrors src/components/theme/ThemeToggle.tsx's
// pattern: a plain localStorage-backed preference, no context provider or
// routing-based locale — simplest thing that works for "just the shell."
//
// This is a separate concern from the AI command parser's own multi-language
// support (server/src/llm/actionParser.ts) — that's the model understanding
// what an operator typed, in whatever language; this is the UI's own static
// labels being available in the same languages this fleet's operators
// actually use.
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
  downloads: string;
  softwareDeploy: string;
  agentUpdates: string;
  uninstallSoftware: string;
  users: string;
  organizations: string;
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
    downloads: "Downloads",
    softwareDeploy: "Software Deploy",
    agentUpdates: "Agent Updates",
    uninstallSoftware: "Uninstall Software",
    users: "Users",
    organizations: "Organizations",
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
    downloads: "ดาวน์โหลด",
    softwareDeploy: "ติดตั้งซอฟต์แวร์",
    agentUpdates: "อัปเดตเอเจนต์",
    uninstallSoftware: "ถอนโปรแกรม",
    users: "ผู้ใช้งาน",
    organizations: "องค์กร",
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
    downloads: "下载",
    softwareDeploy: "软件部署",
    agentUpdates: "代理更新",
    uninstallSoftware: "卸载软件",
    users: "用户",
    organizations: "组织",
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
