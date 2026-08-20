"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

// แทนที่ string class "rounded-md border border-border px-3 py-1.5 text-sm
// ..." ที่ซ้ำกันอยู่ในเกือบทุกหน้า — รวมไว้ที่เดียวเพื่อให้คำศัพท์เรื่อง
// tone/variant สอดคล้องกัน ไม่ต้องคิดใหม่ทุกครั้งที่ทำปุ่ม ตั้งใจให้เล็ก
// ไว้: variant/tone ครอบคลุมแค่ที่ใช้จริงตอนนี้ ไม่ได้ทำเป็น API ของ
// design system เต็มรูปแบบล่วงหน้า
type Variant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: string;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-border text-ink-secondary hover:bg-gridline/40",
  danger: "border border-status-critical/30 text-status-critical hover:bg-status-critical/10",
  ghost: "text-ink-secondary hover:bg-gridline/40",
};

export function Button({ variant = "secondary", icon, children, className = "", ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {icon && <span className="material-symbols-outlined text-[18px]">{icon}</span>}
      {children}
    </button>
  );
}
