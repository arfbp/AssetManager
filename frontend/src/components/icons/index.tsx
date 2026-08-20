// ชุดไอคอนแบบ inline เล็กๆ ที่ใช้ร่วมกันทั่ว dashboard — ภาษาภาพเดียวกับ
// ไอคอน nav ของ sidebar (viewBox 20x20, มีแค่เส้น stroke, ใช้ currentColor)
// เพื่อไม่ให้ไอคอนของ stat tile กับไอคอนของ nav ดูเหมือนมาจากคนละชุด
type IconProps = { className?: string };

const BASE = "h-[18px] w-[18px]";

export function MonitorIcon({ className = BASE }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="9.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 17h6M10 13.5V17" />
    </svg>
  );
}

export function CheckCircleIcon({ className = BASE }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M7 10.2l2 2 4-4.4" />
    </svg>
  );
}

export function PowerIcon({ className = BASE }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M10 3.5v5" />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M6.3 5.7a6 6 0 1 0 7.4 0" />
    </svg>
  );
}

export function AlertTriangleIcon({ className = BASE }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" d="M10 3.2 17.3 16H2.7L10 3.2Z" />
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M10 8v3.4" />
      <circle cx="10" cy="13.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function ActivityIcon({ className = BASE }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M2.5 10.5h3l1.8-5 2.8 9 1.8-5.5h1.6l1.2 2.5h3.3" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}
