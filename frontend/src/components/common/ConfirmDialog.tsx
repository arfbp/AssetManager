"use client";

// modal ยืนยันที่จัดกลางจอและมีสไตล์เป็นของตัวเอง — แทนที่ window.confirm()
// ของเบราว์เซอร์ (แต่งสไตล์ไม่ได้ ดูขัดกับหน้าตาแอป) และปุ่ม confirm/
// cancel แบบ inline เดิมของ chat console เพื่อให้ทุกจุดที่ต้องถาม
// "แน่ใจไหม" ในแอปมีหน้าตาและพฤติกรรมเหมือนกันหมด
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warning" | "info";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_STYLES: Record<NonNullable<ConfirmDialogProps["tone"]>, { icon: string; ring: string; button: string }> = {
  danger: { icon: "!", ring: "bg-status-critical/10 text-status-critical", button: "bg-status-critical hover:opacity-90" },
  warning: { icon: "!", ring: "bg-status-warning/10 text-status-warning", button: "bg-status-warning hover:opacity-90" },
  info: { icon: "i", ring: "bg-accent/10 text-accent", button: "bg-accent hover:bg-accent-hover" },
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "warning",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  const style = TONE_STYLES[tone];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onCancel} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow-2xl">
        <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full text-2xl font-bold ${style.ring}`}>
          {style.icon}
        </div>
        <h2 className="mt-4 text-base font-semibold text-ink-primary">{title}</h2>
        <p className="mt-2 whitespace-pre-line text-sm text-ink-secondary">{message}</p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${style.button}`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
