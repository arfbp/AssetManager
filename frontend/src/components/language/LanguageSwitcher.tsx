"use client";

import { LOCALES, LOCALE_LABELS, setStoredLocale, type Locale } from "@/lib/i18n";

/**
 * Switches the shell's UI language (sidebar nav + header — see
 * lib/i18n.ts's SHELL_STRINGS for scope). Deliberately a plain <select>
 * next to ThemeToggle rather than a new dropdown widget — three options,
 * no need for anything fancier. AppShell owns the actual `locale` state
 * (read from localStorage on mount, same pattern ThemeToggle uses for
 * light/dark) since it's the only component that renders translated shell
 * strings; this component is just the control.
 */
export function LanguageSwitcher({ locale, onChange }: { locale: Locale; onChange: (locale: Locale) => void }) {
  return (
    <select
      value={locale}
      onChange={(e) => {
        const next = e.target.value as Locale;
        setStoredLocale(next);
        onChange(next);
      }}
      title="Language"
      aria-label="Language"
      className="h-8 rounded-md border border-border bg-page px-1.5 text-xs text-ink-secondary outline-none focus:ring-2 focus:ring-accent"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
