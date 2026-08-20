"use client";

import { LOCALES, LOCALE_LABELS, setStoredLocale, type Locale } from "@/lib/i18n";

/**
 * สลับภาษา UI ของ shell (nav ของ sidebar + header — ดูขอบเขตที่
 * SHELL_STRINGS ใน lib/i18n.ts) ตั้งใจใช้ <select> ธรรมดาวางข้างๆ
 * ThemeToggle แทนที่จะทำ dropdown widget ใหม่ — มีแค่สามตัวเลือก ไม่จำเป็น
 * ต้องทำอะไรซับซ้อนกว่านี้ AppShell เป็นเจ้าของ state `locale` จริง (อ่าน
 * จาก localStorage ตอน mount แบบเดียวกับที่ ThemeToggle ทำกับ light/dark)
 * เพราะเป็น component เดียวที่ render ข้อความ shell ที่แปลแล้ว ส่วน
 * component นี้เป็นแค่ตัวควบคุม
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
