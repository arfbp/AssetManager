"use client";

import { useState } from "react";

// ช่องเลือกอุปกรณ์แบบค้นหาได้ ไม่ใช่ <select> ยาวๆ ธรรมดา — ใช้ทุกที่ที่
// หน้าต้องระบุอุปกรณ์ online หนึ่งเครื่องก่อนยิง run_script แสดงเฉพาะ
// agent ที่ online เท่านั้น เพราะ run_script ไม่มีคิวส่งงานรอ ถ้า offline
// คำสั่งก็แค่ไปไม่ถึงปลายทางเลย
export function DeviceSearchSelect({
  agentId,
  onChange,
  onlineAgents,
  label = "Target device",
}: {
  agentId: string;
  onChange: (id: string) => void;
  onlineAgents: { agentId: string }[];
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = onlineAgents.filter((a) => a.agentId.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="relative">
      <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</label>
      <div className="relative mt-1">
        <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-ink-muted">
          search
        </span>
        <input
          type="text"
          value={agentId ? agentId : query}
          onChange={(e) => {
            onChange("");
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search online devices…"
          className="w-full rounded-lg border border-border bg-page py-2 pl-8 pr-3 text-sm text-ink-primary outline-none focus:border-accent"
        />
      </div>
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {filtered.map((a) => (
            <button
              key={a.agentId}
              type="button"
              onMouseDown={() => {
                onChange(a.agentId);
                setQuery("");
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-primary hover:bg-page"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-status-good" />
              {a.agentId}
            </button>
          ))}
          {filtered.length === 0 && <div className="p-3 text-xs text-ink-muted">No matching online devices.</div>}
        </div>
      )}
      {onlineAgents.length === 0 && <p className="mt-1 text-xs text-ink-muted">No devices are online right now.</p>}
    </div>
  );
}
