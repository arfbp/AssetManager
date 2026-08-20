"use client";

import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { StatusBadge } from "@/components/status/StatusBadge";
import { ChatConsole } from "@/components/chat/ChatConsole";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";

// หน้า AI Console แบบ standalone — ใช้ ChatConsole ตัวเดียวกับที่อยู่ใน drawer
// ของแต่ละ device แต่เข้าถึงได้ตรงจาก sidebar โดยไม่ต้องเปิด device ใดก่อน
// ค่าเริ่มต้นเป็น scope "All devices" (ไม่ส่ง defaultScope/history filter)
// เพื่อให้ operator สั่งคำสั่งระดับ fleet หรือกลุ่ม device ได้จากตรงนี้เลย
// โดยไม่ต้องผ่าน frame แบบเดิมที่ deep link /devices?console=1 ใช้ (เปิด
// device drawer แบบไม่ได้เลือก device ใดไว้)
function Console({ username }: { username: string }) {
  const { agents, history, connectionStatus, commandOutputs } = useDashboardSocket();

  return (
    <AppShell
      username={username}
      connectionStatus={connectionStatus}
      statusSlot={
        <StatusBadge
          tone={connectionStatus === "open" ? "good" : "critical"}
          label={connectionStatus === "open" ? "Live" : connectionStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      }
    >
      <div className="mx-auto flex h-[calc(100vh-120px)] max-w-4xl flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-3/10 text-series-3">
            <span className="material-symbols-outlined text-[24px]">auto_awesome</span>
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">AI Console</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              Natural-language fleet commands, in English, Thai, or Chinese — target one device or leave it on
              &ldquo;All devices&rdquo; for a group command.
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <ChatConsole agents={agents} history={history} commandOutputs={commandOutputs} />
        </div>
      </div>
    </AppShell>
  );
}

export default function ConsolePage() {
  return <AuthGate>{(username) => <Console username={username} />}</AuthGate>;
}
