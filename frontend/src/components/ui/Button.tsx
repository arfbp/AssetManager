"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

// Replaces the same "rounded-md border border-border px-3 py-1.5 text-sm
// ..." utility string repeated across most pages — one place to keep the
// tone/variant vocabulary consistent instead of re-deriving it per button.
// Deliberately small: variant/tone cover what's actually used today, not a
// speculative full design-system API.
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
