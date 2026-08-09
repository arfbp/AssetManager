import type { HTMLAttributes, ReactNode } from "react";

// The ".glass-card rounded-xl" combination already repeated across most
// pages (organizations, users, the main dashboard, ...) — a thin wrapper so
// new pages reach for one component instead of re-typing the same three
// classes, not a new visual treatment.
interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Panel({ children, className = "", ...rest }: PanelProps) {
  return (
    <div className={`glass-card overflow-hidden rounded-xl ${className}`} {...rest}>
      {children}
    </div>
  );
}
