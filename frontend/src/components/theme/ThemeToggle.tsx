"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "optifleet-theme";

function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme"); // follow OS preference
  }
}

/**
 * Explicit light/dark toggle, separate from (and overriding) the OS
 * preference — per the dataviz skill, dark mode is a *selected* state, not
 * an automatic-only flip. `null` means "follow the system," which is the
 * default until the operator picks one.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    setTheme(stored);
    applyTheme(stored);
    setMounted(true);
  }, []);

  function cycle(): void {
    // light -> dark -> follow system -> light -> …
    const next: Theme | null = theme === "light" ? "dark" : theme === "dark" ? null : "light";
    setTheme(next);
    applyTheme(next);
    if (next) window.localStorage.setItem(STORAGE_KEY, next);
    else window.localStorage.removeItem(STORAGE_KEY);
  }

  if (!mounted) {
    // Avoid a hydration flash: render a stable placeholder until we know
    // the stored preference.
    return <div className="h-8 w-8" aria-hidden="true" />;
  }

  const label = theme === "light" ? "Light theme" : theme === "dark" ? "Dark theme" : "System theme";

  return (
    <button
      type="button"
      onClick={cycle}
      title={`${label} — click to change`}
      aria-label={`Theme: ${label}. Click to change.`}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink-secondary transition-colors hover:bg-gridline/40"
    >
      {theme === "light" ? (
        <SunIcon />
      ) : theme === "dark" ? (
        <MoonIcon />
      ) : (
        <SystemIcon />
      )}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M10 2.5v1.6M10 15.9v1.6M17.5 10h-1.6M4.1 10H2.5M15.1 4.9l-1.1 1.1M6 14l-1.1 1.1M15.1 15.1L14 14M6 6 4.9 4.9"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M17 12.1A7 7 0 0 1 7.9 3a7 7 0 1 0 9.1 9.1Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 17h6M10 14v3" />
    </svg>
  );
}
