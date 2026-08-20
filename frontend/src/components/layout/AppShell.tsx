"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { LanguageSwitcher } from "@/components/language/LanguageSwitcher";
import { Button } from "@/components/ui/Button";
import { logout, getStoredRole, getStoredIsPlatformAdmin } from "@/lib/session";
import { getOrgBranding, resolveLogoUrl } from "@/lib/branding";
import { SHELL_STRINGS, getStoredLocale, type Locale } from "@/lib/i18n";

type NavSection = "fleet" | "erp" | "accounting" | "deploy" | "administration" | "platform";

interface NavItem {
  href: string;
  labelKey: keyof (typeof SHELL_STRINGS)["en"];
  icon: string;
  section: NavSection;
  adminOnly?: boolean;
  // ต่างจาก adminOnly: it_support ยังเห็นเมนูนี้ได้ มีแค่ viewer (สิทธิ์
  // อ่านอย่างเดียวทั้งระบบ) เท่านั้นที่เห็นไม่ได้ — สอดคล้องกับที่ตัว
  // ติดตั้งของหน้า Downloads พก auth token/HMAC secret จริงของ agent ซึ่ง
  // ความอ่อนไหวอยู่ระดับเดียวกับการยิงคำสั่งหรือแก้ไข asset ไม่ใช่ระดับ
  // จัดการผู้ใช้ (admin เท่านั้น)
  hideForViewer?: boolean;
  // เข้มกว่า adminOnly: เห็นได้เฉพาะ admin ของเจ้าของแพลตฟอร์มเองเท่านั้น
  // (ดู PLATFORM_ORG_ID ใน server/src/orgs/orgsStore.ts) — admin ของ org
  // ลูกค้าเองก็มี role "admin" เหมือนกัน แต่ต้องไม่มีวันเห็นหรือเข้าถึง
  // การจัดการ org ได้
  platformAdminOnly?: boolean;
}

// จัดกลุ่มเป็นหมวดที่มีป้ายกำกับใน sidebar (ดู navLinks ด้านล่าง) แทนที่
// จะเป็นรายการเดียวยาวๆ — สี่หมวดนี้แบ่งตามคร่าวๆ ว่าใครใช้: ผู้ใช้ที่
// ล็อกอินทุกคน (Fleet), ใครก็ตามที่ push software ได้ (Deploy & Maintain),
// admin ของ org นี้เอง (Administration) และเจ้าของแพลตฟอร์มเท่านั้น
// (Platform) ลำดับใน NAV_ITEMS มีผลแค่ภายในหมวดเดียวกัน ส่วนลำดับ/ชื่อ
// หมวดกำหนดไว้ที่เดียวใน SECTION_ORDER ด้านล่าง
const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "dashboard", icon: "dashboard", section: "fleet" },
  { href: "/devices", labelKey: "devices", icon: "computer", section: "fleet" },
  { href: "/console", labelKey: "aiConsole", icon: "auto_awesome", section: "fleet" },
  { href: "/tracking", labelKey: "liveTracking", icon: "location_on", section: "fleet" },
  { href: "/assets", labelKey: "assetRegistry", icon: "inventory_2", section: "fleet" },
  { href: "/employees", labelKey: "employees", icon: "badge", section: "erp" },
  { href: "/vendors", labelKey: "vendors", icon: "local_shipping", section: "erp" },
  { href: "/purchase-orders", labelKey: "purchaseOrders", icon: "receipt_long", section: "erp" },
  { href: "/asset-models", labelKey: "assetModels", icon: "category", section: "erp" },
  { href: "/maintenance", labelKey: "maintenance", icon: "build", section: "erp" },
  { href: "/handovers", labelKey: "handovers", icon: "assignment_turned_in", section: "erp" },
  { href: "/asset-requests", labelKey: "assetRequests", icon: "fact_check", section: "erp" },
  { href: "/licenses", labelKey: "licenses", icon: "key", section: "erp" },
  { href: "/asset-transfers", labelKey: "assetTransfers", icon: "sync_alt", section: "erp" },
  { href: "/asset-counts", labelKey: "assetCounts", icon: "checklist", section: "erp" },
  { href: "/asset-adjustments", labelKey: "assetAdjustments", icon: "tune", section: "erp" },
  { href: "/asset-retirements", labelKey: "assetRetirements", icon: "archive", section: "erp" },
  { href: "/gl-accounts", labelKey: "glAccounts", icon: "account_balance", section: "accounting", adminOnly: true },
  { href: "/journal-entries", labelKey: "journalEntries", icon: "menu_book", section: "accounting", adminOnly: true },
  { href: "/fiscal-periods", labelKey: "fiscalPeriods", icon: "event_repeat", section: "accounting", adminOnly: true },
  { href: "/depreciation-runs", labelKey: "depreciationRuns", icon: "calculate", section: "accounting", adminOnly: true },
  { href: "/downloads", labelKey: "downloads", icon: "download", section: "deploy", hideForViewer: true },
  { href: "/software-deploy", labelKey: "softwareDeploy", icon: "install_desktop", section: "deploy", adminOnly: true },
  { href: "/agent-updates", labelKey: "agentUpdates", icon: "system_update", section: "deploy", adminOnly: true },
  { href: "/uninstall-software", labelKey: "uninstallSoftware", icon: "delete_sweep", section: "deploy", adminOnly: true },
  { href: "/users", labelKey: "users", icon: "group", section: "administration", adminOnly: true },
  { href: "/org-settings", labelKey: "orgSettings", icon: "palette", section: "administration", adminOnly: true },
  { href: "/organizations", labelKey: "organizations", icon: "corporate_fare", section: "platform", platformAdminOnly: true },
  { href: "/audit-log", labelKey: "auditLog", icon: "history", section: "platform", platformAdminOnly: true },
];

const SECTION_ORDER: { key: NavSection; labelKey: keyof (typeof SHELL_STRINGS)["en"] }[] = [
  { key: "fleet", labelKey: "navSectionFleet" },
  { key: "erp", labelKey: "navSectionErp" },
  { key: "accounting", labelKey: "navSectionAccounting" },
  { key: "deploy", labelKey: "navSectionDeploy" },
  { key: "administration", labelKey: "navSectionAdministration" },
  { key: "platform", labelKey: "navSectionPlatform" },
];

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * โครง admin panel ถาวรที่ใช้ร่วมกันทุกหน้าที่ล็อกอินแล้ว — sidebar ด้าน
 * ซ้าย (ตั้งใจให้เป็นธีมมืดตายตัว ดู globals.css) สำหรับ navigation หลัก
 * และ top bar ที่มีตัวควบคุมข้อมูลผู้ใช้/session รวมถึงสถานะเฉพาะหน้าที่
 * ฝั่งเรียกใช้ส่งเข้ามา (เช่น badge สถานะการเชื่อมต่อ live ของ dashboard)
 * เนื้อหาของแต่ละหน้า render ผ่าน `children` เท่านั้น ไม่มี header เป็น
 * ของตัวเองอีกต่อไป
 *
 * ภาษาภาพ (glass card, โทนสีกรมท่า/น้ำเงินนี้, ไอคอน Material Symbols)
 * อ้างอิงตาม mockup ที่ผู้ใช้ต้องการให้ทำตาม — ดู comment เรื่อง token ใน
 * globals.css
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export function AppShell({
  username,
  statusSlot,
  notificationCount,
  connectionStatus,
  children,
}: {
  username: string;
  statusSlot?: React.ReactNode;
  /** ใช้เฉพาะจำนวนจริงเท่านั้น — ไม่ส่งมาดีกว่าใส่ badge ที่ไม่มีข้อมูลจริงรองรับ ตอนนี้มีแค่ Dashboard ที่คำนวณค่านี้ */
  notificationCount?: number;
  /** เมื่อเป็น "closed" จะแสดง banner อธิบายสาเหตุที่เป็นไปได้ แทนที่จะ
   * ปล่อยให้ทุกหน้าขึ้น "0 devices" หรือ empty state เงียบๆ ที่หน้าตา
   * เหมือนฟลีตว่างเปล่าจริงๆ ทุกประการ สาเหตุที่พบบ่อยที่สุดบน deployment
   * ที่ใช้ self-signed cert คือ เบราว์เซอร์ยังไม่เคยเข้า origin HTTPS ของ
   * API เลย จึงบล็อก fetch/WebSocket ไปยังมันแบบเงียบๆ — ดูข้อความใน
   * banner ด้านล่างสำหรับวิธีแก้จริง */
  connectionStatus?: "connecting" | "open" | "closed";
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // AppShell จะ mount ก็ต่อเมื่อ AuthGate เข้าสถานะ "authenticated" แล้ว
  // เท่านั้น (เป็นการเปลี่ยนสถานะฝั่ง client ล้วนๆ ดู AuthGate.tsx) จึงไม่มี
  // ทางรันตอน server render และไม่เกิด hydration mismatch — เหตุผล
  // เดียวกันนี้ใช้กับการอ่าน locale ที่เก็บไว้ด้านล่างด้วย
  const role = getStoredRole();
  const isPlatformAdmin = getStoredIsPlatformAdmin();
  const visibleNavItems = NAV_ITEMS.filter(
    (item) =>
      (!item.adminOnly || role === "admin") &&
      (!item.hideForViewer || role !== "viewer") &&
      (!item.platformAdminOnly || isPlatformAdmin),
  );
  const [locale, setLocale] = useState<Locale>(() => getStoredLocale());
  const t = SHELL_STRINGS[locale];
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOrgBranding().then((branding) => {
      if (!cancelled && branding?.logoUrl) setLogoUrl(resolveLogoUrl(branding.logoUrl));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSearch(e: FormEvent): void {
    e.preventDefault();
    const q = search.trim();
    router.push(q ? `/devices?q=${encodeURIComponent(q)}` : "/devices");
  }

  // ใช้ร่วมกันทั้ง sidebar เดสก์ท็อปที่แสดงตลอด และ drawer แบบเลื่อนเข้า
  // บนมือถือ — nav item ชุดเดียวป้อนให้สอง layout เพื่อไม่ต้องแก้สองที่
  // เวลาเพิ่มหน้าใหม่ใน NAV_ITEMS และสองฝั่งจะไม่มีวันไม่ตรงกันเรื่องลิงก์
  // ที่มี จัดกลุ่มตาม section (SECTION_ORDER) มีป้ายกำกับเหนือแต่ละกลุ่มที่
  // ไม่ว่าง — หมวดที่ role นั้นมองไม่เห็นอะไรเลย (เช่น Platform สำหรับคนที่
  // ไม่ใช่ platform admin) จะถูกข้ามไปทั้งหมด ไม่แสดงป้ายกำกับเปล่าๆ ไม่มี
  // ลิงก์ข้างใต้
  function navLinks(onNavigate?: () => void): React.ReactNode {
    return SECTION_ORDER.map(({ key, labelKey }) => {
      const items = visibleNavItems.filter((item) => item.section === key);
      if (items.length === 0) return null;
      return (
        <div key={key} className="pb-3">
          <p className="px-3 pb-1.5 pt-3 text-[10px] font-bold uppercase tracking-widest text-sidebar-ink-muted">{t[labelKey]}</p>
          <div className="flex flex-col gap-0.5">
            {items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={`relative flex items-center gap-3 rounded-md py-2.5 pl-3 pr-3 text-sm font-medium transition-colors ${
                    active ? "bg-sidebar-active text-sidebar-ink-active" : "text-sidebar-ink hover:bg-sidebar-active/60 hover:text-sidebar-ink-active"
                  }`}
                >
                  {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-sidebar-accent" aria-hidden="true" />}
                  <span className="material-symbols-outlined text-[20px]" style={active ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                    {item.icon}
                  </span>
                  {t[item.labelKey]}
                </Link>
              );
            })}
          </div>
        </div>
      );
    });
  }

  function brandBlock(): React.ReactNode {
    return (
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sidebar-accent text-white">
          <img src={logoUrl ?? "/optifleet-mark.svg"} alt="" className="h-5 w-5" />
        </div>
        <div className="leading-none">
          <h1 className="font-display text-sm font-bold text-sidebar-ink-active">OptiFleet AI</h1>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-sidebar-ink-muted">{t.backofficeConsole}</p>
        </div>
      </div>
    );
  }

  function identityBlock(): React.ReactNode {
    return (
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-sidebar-accent/40 bg-sidebar-active text-sm font-bold text-sidebar-ink-active">
            {initials(username)}
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-bold text-sidebar-ink-active">{username}</p>
            <p className="text-[11px] text-sidebar-ink-muted">{t.signedIn}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col bg-sidebar sm:flex">
        {brandBlock()}
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">{navLinks()}</nav>
        {identityBlock()}
      </aside>

      {/* nav บนมือถือ: เป็น drawer เลื่อนเข้าจริงๆ ไม่ใช่แถวลิงก์แนวนอน —
          ของเดิมที่เป็นแถว "sm:hidden" เรียงป้ายชื่อ nav ทุกอันแนวนอนล้น
          ออกขอบขวาจอโดยไม่มีทางเลื่อนไปดูได้ เมื่อจำนวนหน้าเยอะเกินหนึ่ง
          บรรทัด (ทดสอบจริงบนหน้าจอกว้าง 390px แล้วพบว่า Software
          Deploy/Agent Updates/Uninstall Software/Users ตกขอบไปหมด กดไม่ถึง
          เลย) */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <button type="button" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} className="absolute inset-0 bg-black/40" />
          <aside className="relative z-10 flex h-full w-64 max-w-[80vw] flex-col bg-sidebar shadow-2xl">
            {brandBlock()}
            <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-2">{navLinks(() => setMobileNavOpen(false))}</nav>
            {identityBlock()}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 shadow-sm sm:px-6">
          <div className="flex items-center gap-2 sm:hidden">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open menu"
              className="flex h-9 w-9 items-center justify-center rounded-md text-ink-secondary hover:bg-gridline/40"
            >
              <span className="material-symbols-outlined text-[22px]">menu</span>
            </button>
            <span className="font-display text-sm font-semibold text-ink-primary">OptiFleet AI</span>
          </div>

          <form onSubmit={handleSearch} className="hidden flex-1 max-w-xl sm:block">
            <div className="relative w-full">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-ink-muted">search</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                type="text"
                placeholder={t.searchPlaceholder}
                className="w-full rounded-full border-none bg-gridline/40 py-2 pl-10 pr-4 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
          </form>

          <div className="flex items-center gap-3">
            {statusSlot}
            <button type="button" className="relative p-2 text-ink-muted transition-colors hover:text-accent" title={t.needsAttention}>
              <span className="material-symbols-outlined text-[22px]">notifications</span>
              {Boolean(notificationCount) && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-status-critical" aria-hidden="true" />}
            </button>
            <span className="hidden text-xs text-ink-secondary md:inline">
              {t.signedInAs} <span className="font-medium text-ink-primary">{username}</span>
            </span>
            <Button variant="secondary" className="!px-2 !py-1 !text-xs" onClick={() => logout().then(() => window.location.reload())}>
              {t.logOut}
            </Button>
            <LanguageSwitcher locale={locale} onChange={setLocale} />
            <ThemeToggle />
          </div>
        </header>

        {connectionStatus === "closed" && (
          <div className="flex items-start gap-3 border-b border-status-critical/30 bg-status-critical/10 px-4 py-3 sm:px-6">
            <span className="material-symbols-outlined mt-0.5 text-status-critical">error</span>
            <div className="text-sm text-ink-primary">
              <p className="font-semibold text-status-critical">Can't reach the server — data on this page may be stale or empty.</p>
              <p className="mt-0.5 text-ink-secondary">
                If the server uses a self-signed certificate, your browser needs to trust it once:{" "}
                <a href={API_URL} target="_blank" rel="noreferrer" className="font-medium text-accent underline">
                  open {API_URL}
                </a>{" "}
                in a new tab, accept the security warning, then reload this page.
              </p>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
