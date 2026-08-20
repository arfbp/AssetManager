import type { HTMLAttributes, ReactNode } from "react";

// การผสม class ".glass-card rounded-xl" ซ้ำอยู่แล้วในเกือบทุกหน้า
// (organizations, users, dashboard หลัก, ...) — ห่อไว้บางๆ เพื่อให้หน้า
// ใหม่ๆ เรียกใช้ component เดียวแทนพิมพ์ class สามตัวซ้ำ ไม่ได้เป็นการ
// เปลี่ยนรูปแบบภาพใหม่แต่อย่างใด
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
