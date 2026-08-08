"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { LanguageSwitcher } from "@/components/language/LanguageSwitcher";
import { logout, getStoredRole, getStoredIsPlatformAdmin } from "@/lib/session";
import { SHELL_STRINGS, getStoredLocale, type Locale } from "@/lib/i18n";

interface NavItem {
  href: string;
  labelKey: keyof (typeof SHELL_STRINGS)["en"];
  icon: string;
  adminOnly?: boolean;
  // Distinct from adminOnly: it_support can still see this, only viewer
  // (read-only everywhere) can't — matches how the Downloads page's
  // installer carries the real agent auth token/HMAC secret, the same
  // sensitivity tier as dispatching commands or editing assets, not
  // user-management-level (admin-only).
  hideForViewer?: boolean;
  // Stricter than adminOnly: only the platform owner's own admins (see
  // server/src/orgs/orgsStore.ts's PLATFORM_ORG_ID) — a customer org's own
  // admin is role "admin" too but must never see or reach org-management.
  platformAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "dashboard", icon: "dashboard" },
  { href: "/devices", labelKey: "devices", icon: "computer" },
  { href: "/console", labelKey: "aiConsole", icon: "auto_awesome" },
  { href: "/tracking", labelKey: "liveTracking", icon: "location_on" },
  { href: "/assets", labelKey: "assetRegistry", icon: "inventory_2" },
  { href: "/downloads", labelKey: "downloads", icon: "download", hideForViewer: true },
  { href: "/software-deploy", labelKey: "softwareDeploy", icon: "install_desktop", adminOnly: true },
  { href: "/agent-updates", labelKey: "agentUpdates", icon: "system_update", adminOnly: true },
  { href: "/uninstall-software", labelKey: "uninstallSoftware", icon: "delete_sweep", adminOnly: true },
  { href: "/users", labelKey: "users", icon: "group", adminOnly: true },
  { href: "/organizations", labelKey: "organizations", icon: "corporate_fare", platformAdminOnly: true },
];

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Persistent admin-panel frame shared by every authenticated page — a
 * left sidebar (deliberately always dark, see globals.css) for primary
 * navigation, and a top bar carrying identity/session controls plus
 * whatever page-specific status the caller passes in (e.g. the dashboard's
 * live-connection badge). Page bodies render into `children` only; they no
 * longer own their own header markup.
 *
 * Visual language (glass cards, this navy/blue palette, Material Symbols
 * icons) matches a reference mockup the user asked to clone — see
 * globals.css's token comment.
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
  /** Real count only — omit rather than fabricate a badge with nothing behind it. Only the Dashboard currently computes this. */
  notificationCount?: number;
  /** When "closed", shows a real banner explaining the likely cause instead
   * of letting every page quietly render "0 devices" / empty states that
   * look identical to a genuinely empty fleet. The single most common cause
   * on a self-signed-cert deployment: the browser has never been to the
   * API's own HTTPS origin, so it silently blocks every fetch/WebSocket to
   * it — see the banner text below for the actual fix. */
  connectionStatus?: "connecting" | "open" | "closed";
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // AppShell only ever mounts after AuthGate reaches "authenticated" (a
  // purely client-side transition — see AuthGate.tsx), so this never runs
  // during a server render and can't produce a hydration mismatch — same
  // reasoning applies to reading the stored locale below.
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

  function handleSearch(e: FormEvent): void {
    e.preventDefault();
    const q = search.trim();
    router.push(q ? `/devices?q=${encodeURIComponent(q)}` : "/devices");
  }

  // Shared between the always-visible desktop sidebar and the mobile
  // slide-in drawer — one nav item list feeding two layouts, so a page
  // added to NAV_ITEMS never needs updating in two places, and the two
  // surfaces can't drift out of sync on which links exist.
  function navLinks(onNavigate?: () => void): React.ReactNode {
    return visibleNavItems.map((item) => {
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
    });
  }

  function brandBlock(): React.ReactNode {
    return (
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sidebar-accent text-white">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
            psychology
          </span>
        </div>
        <div className="leading-none">
          <h1 className="text-sm font-bold text-sidebar-ink-active">OptiFleet AI</h1>
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

      {/* Mobile nav: a real slide-in drawer, not a horizontal link row —
          the earlier "sm:hidden" inline row of every nav label overflowed
          off the right edge of the viewport with no way to scroll to it
          once enough pages existed to outgrow one line (verified on a real
          390px-wide viewport: Software Deploy/Agent Updates/Uninstall
          Software/Users all landed past the visible edge, unreachable). */}
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
            <span className="text-sm font-semibold text-ink-primary">OptiFleet AI</span>
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
            <button
              type="button"
              onClick={() => logout().then(() => window.location.reload())}
              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
            >
              {t.logOut}
            </button>
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
