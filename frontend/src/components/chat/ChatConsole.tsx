"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CreateOrgModal, type CreateOrgPrefill } from "@/components/orgs/CreateOrgModal";
import { AddUserModal, type AddUserPrefill } from "@/components/users/AddUserModal";
import { VendorFormModal, type VendorPrefill } from "@/components/vendors/VendorFormModal";
import { PurchaseOrderFormModal, type PurchaseOrderPrefill } from "@/components/procurement/PurchaseOrderFormModal";
import { ApiError, confirmCommand, submitCommand, downloadOrgInstaller, downloadAgentInstaller } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import type { AgentSummary, HistoryEntry, HistoryEntryStatus } from "@/lib/types";
import type { StreamedCommandOutput } from "@/hooks/useDashboardSocket";

interface ChatMessage {
  id: string;
  role: "user" | "system";
  text: string;
  tone?: "info" | "success" | "error" | "pending";
  // สิ่งที่โมเดลเข้าใจว่าคำขอหมายถึงอะไร แสดงเป็นบรรทัดรองเล็กๆ ให้ผู้ใช้
  // เห็นเจตนาที่ระบบตีความ ไม่ใช่แค่ผลลัพธ์
  reasoning?: string;
  // ตั้งค่าเฉพาะตอนยิง network_diagnostic (ping/tracert/nslookup/netstat)
  // สำเร็จ — หนึ่งรายการต่อหนึ่งอุปกรณ์ปลายทาง render แบบ real-time จาก
  // prop commandOutputs ที่อัปเดตเมื่อมีข้อมูลส่งมาทาง WebSocket ของ
  // dashboard ทำให้ผู้ใช้เห็น hop/การตอบกลับทยอยขึ้นทีละอันแทนที่จะรอ
  // คำสั่งทำงานเสร็จทั้งหมดก่อน
  streamTargets?: { commandId: string; agentId: string }[];
  // ตั้งค่าเฉพาะตอนได้ admin_result แบบ generate_installer — ใช้ render
  // ปุ่ม "Download installer" โดยเรียก route เดียวกับที่หน้า Downloads/
  // Organizations ใช้อยู่แล้ว ดู downloadAgentInstaller/downloadOrgInstaller
  // ใน api.ts
  installer?: { orgId: string; subdomain: string; ownOrg: boolean };
  // ใครส่งและส่งเมื่อไหร่ — ตั้งค่าเฉพาะรายการที่ประกอบขึ้นจาก history
  // ฝั่งเซิร์ฟเวอร์ (ดู buildHistoryMessages) เพื่อให้ session เก่ายังเห็น
  // audit trail เหมือนที่ command_history/"Recent activity" แสดง ไม่ตั้ง
  // ค่านี้กับข้อความจาก session ปัจจุบันที่กำลังคุยอยู่สด — เพราะ "ใคร"
  // ก็คือผู้ใช้ที่กำลังพิมพ์อยู่นั่นเอง
  meta?: string;
}

const HISTORY_STATUS_TONE: Record<HistoryEntryStatus, ChatMessage["tone"]> = {
  succeeded: "success",
  failed: "error",
  dispatched: "pending",
  offline: "pending",
};

const HISTORY_STATUS_FALLBACK: Record<HistoryEntryStatus, string> = {
  succeeded: "Completed successfully.",
  failed: "Failed.",
  dispatched: "Dispatched — awaiting result.",
  offline: "Device was offline when this was sent.",
};

// ประกอบบทสนทนาก่อนหน้าขึ้นใหม่จากตาราง command_history ที่เก็บถาวรไว้
// (ข้อมูลชุดเดียวกับที่ "Recent activity" และแท็บ "Commands" ใน drawer
// อ่าน) เพื่อให้เปิด console นี้ใหม่แล้วเห็นสิ่งที่เคยส่งไปยังอุปกรณ์นี้
// แล้ว แทนที่จะเริ่มว่างเปล่าทุกครั้ง — ทุกรายการมี requestedBy ที่มาจาก
// ฝั่งเซิร์ฟเวอร์เสมอ ไม่ใช่ค่าที่ client ส่งมาเอง จำกัดขอบเขตไว้แค่
// อุปกรณ์เดียว (ไม่ใช่ dropdown scope ปัจจุบันที่เปลี่ยนเป้าหมายได้โดยไม่
// กระทบ history เก่า) และจำกัดจำนวนรายการล่าสุดไว้ไม่ให้อุปกรณ์เก่าที่ใช้
// งานถี่ทำให้ panel เต็มไปด้วยข้อความจนอ่านไม่ไหว
const MAX_HISTORY_MESSAGES = 20;

function buildHistoryMessages(history: HistoryEntry[], deviceScope: string | undefined): ChatMessage[] {
  if (!deviceScope) return [];
  const relevant = history
    .filter((h) => h.agentId === deviceScope)
    .slice()
    .sort((a, b) => a.dispatchedAt - b.dispatchedAt)
    .slice(-MAX_HISTORY_MESSAGES);

  const out: ChatMessage[] = [];
  for (const entry of relevant) {
    out.push({
      id: `hist-${entry.commandId}-req`,
      role: "user",
      text: entry.sourceText || entry.action,
      meta: `${entry.requestedBy} · ${formatRelativeTime(entry.dispatchedAt)}`,
    });
    out.push({
      id: `hist-${entry.commandId}-res`,
      role: "system",
      tone: HISTORY_STATUS_TONE[entry.status],
      text: entry.message || HISTORY_STATUS_FALLBACK[entry.status],
    });
  }
  return out;
}

interface PendingConfirmation {
  pendingId: string;
  targets: string[];
  reason: string;
  resolved: { action: string; params: Record<string, string> };
}

// การยืนยันฝั่ง admin (ระงับ/เปิดใช้/ลบ org หรือ user) เป็นคนละเรื่องกับ
// การยืนยันฝั่งอุปกรณ์ด้านบน — รูปแบบข้อมูลต่างกัน (ระบุ org/user เป็นชื่อ
// ไม่ใช่รายการอุปกรณ์) แต่ใช้ endpoint POST /command/:id/confirm เดียวกัน
// (ดู pendingAdmin store คู่ใน server/src/api/routes.ts) ส่วน
// delete_organization มีช่องพิมพ์ยืนยันชื่อที่เข้มงวดกว่าด้านล่าง แทน
// ปุ่มใช่/ไม่ใช่ธรรมดา ตามแบบ DeleteOrgModal ของหน้า Organizations เพราะ
// เป็น action เดียวที่ย้อนกลับไม่ได้จริงๆ
interface PendingAdminConfirmation {
  pendingId: string;
  reason: string;
  resolved: { action: string; orgName?: string; username?: string };
}

// การยืนยันฝั่ง Asset Management ERP (อนุมัติ/ปฏิเสธ PO, ปิดงาน
// maintenance, ส่งมอบ asset) — รูปแบบเหมือน PendingAdminConfirmation คือ
// ระบุเป้าหมายเป็นชื่อ ไม่ใช่รายการอุปกรณ์ ใช้ endpoint POST
// /command/:id/confirm เดียวกัน เพียงแต่แยก pending-ID เป็นชุดที่สาม
// ต่างหากฝั่งเซิร์ฟเวอร์ (ดู pendingErp ใน server/src/api/routes.ts)
interface PendingErpConfirmation {
  pendingId: string;
  reason: string;
  resolved: { action: string; poNumber?: string; assetTag?: string };
}

const TONE_CLASS: Record<NonNullable<ChatMessage["tone"]>, string> = {
  info: "text-ink-secondary",
  success: "text-status-good",
  error: "text-status-critical",
  pending: "text-status-warning",
};

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
}

interface ChatConsoleProps {
  agents: AgentSummary[];
  // เลือกอุปกรณ์ล่วงหน้าใน dropdown (เช่นตอนฝังอยู่ใน drawer ของอุปกรณ์ใด
  // อุปกรณ์หนึ่ง) — dropdown ยังสลับไปอุปกรณ์อื่นหรือกลับไป "All devices"
  // สำหรับคำสั่งแบบกลุ่มได้ตามปกติ ค่านี้ยังใช้ดึง history เก่าของ
  // อุปกรณ์นี้มาแสดง (ดู buildHistoryMessages) ด้วย — ถ้าสลับ dropdown
  // ทีหลังจะไม่ดึง history ใหม่มาแทน
  defaultScope?: string;
  // history คำสั่งที่ยิงออกไปทั้งฟลีต (จาก useDashboardSocket) — ใช้แค่
  // ตอน mount เพื่อดึงบทสนทนาเก่าของอุปกรณ์นี้มาแสดง ข้อมูลชุดเดียวกับที่
  // "Recent activity" และแท็บ "Commands" ใน drawer ใช้อยู่แล้ว
  history?: HistoryEntry[];
  // ผลลัพธ์แบบ real-time ของคำสั่ง network_diagnostic ที่กำลังทำงานอยู่
  // แยกตาม commandId — มาจาก useDashboardSocket() รายการที่ยังไม่มีข้อมูล
  // จะ render เป็น "waiting for output…" จนกว่าข้อมูลชิ้นแรกจะมาถึง
  commandOutputs?: Record<string, StreamedCommandOutput>;
}

/**
 * คอนโซลรับคำสั่งภาษาธรรมชาติ ทุกคำสั่งที่ส่งจะผ่าน LLM parser + security
 * guardrail ฝั่งเซิร์ฟเวอร์ (POST /api/command) — component นี้ทำแค่
 * render ผลลัพธ์ที่เซิร์ฟเวอร์ตัดสินใจแล้ว (dispatched / needs
 * confirmation / blocked) ไม่เคยสร้างหรือส่งคำสั่งเองโดยตรง
 *
 * ตัวเลือกอุปกรณ์ไม่บังคับ — ถ้าปล่อยไว้ที่ "All devices" ระบบจะให้โมเดล
 * ดึง scope จากประโยคเอง (คำสั่งแบบกลุ่มอย่าง "clean temp on the
 * accounting group" ต้องพึ่งวิธีนี้ เพราะไม่มีอุปกรณ์เดียวให้เลือกไว้
 * ล่วงหน้า) ถ้าเลือกอุปกรณ์ใดอุปกรณ์หนึ่งไว้ ค่านั้นจะถูกส่งไปแบบ override
 * ทันที (ดู CommandRequestSchema ใน routes.ts) ซึ่งช่วยทั้งเรื่อง UX และ
 * ความแม่นยำ — เพราะโมเดลเคยตีความผิดว่าประโยคหมายถึงอุปกรณ์ไหนมาแล้ว
 * มากกว่าหนึ่งครั้งในโปรเจกต์นี้
 */
export function ChatConsole({ agents, defaultScope, history, commandOutputs }: ChatConsoleProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const seeded = buildHistoryMessages(history ?? [], defaultScope);
    if (seeded.length > 0) return seeded;
    return [
      {
        id: "welcome",
        role: "system",
        tone: "info",
        text: 'Type a request in plain language, e.g. "restart Admin-01" or "clean temp files on the accounting group". Destructive or multi-device actions will ask for confirmation before anything is sent.',
      },
    ];
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(defaultScope ?? "");
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [pendingAdmin, setPendingAdmin] = useState<PendingAdminConfirmation | null>(null);
  const [pendingErp, setPendingErp] = useState<PendingErpConfirmation | null>(null);
  const [deleteOrgConfirmText, setDeleteOrgConfirmText] = useState("");
  const [createOrgPrefill, setCreateOrgPrefill] = useState<CreateOrgPrefill | null>(null);
  const [addUserPrefill, setAddUserPrefill] = useState<AddUserPrefill | null>(null);
  const [vendorPrefill, setVendorPrefill] = useState<VendorPrefill | null>(null);
  const [poPrefill, setPoPrefill] = useState<PurchaseOrderPrefill | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // เลื่อนตามบทสนทนาที่เพิ่มขึ้นเรื่อยๆ — ทั้งข้อความคำสั่งใหม่และผลลัพธ์
  // network_diagnostic ที่ทยอยส่งมาต่างก็ดันเนื้อหาลงมาด้านล่าง จึงต้อง
  // ทำงานซ้ำเมื่อค่าใดค่าหนึ่งเปลี่ยน
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, commandOutputs]);

  function append(msg: Omit<ChatMessage, "id">): void {
    setMessages((prev) => [...prev, { ...msg, id: newId() }]);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    append({ role: "user", text: scope ? `[${scope}] ${text}` : text });
    setInput("");
    setBusy(true);

    try {
      const response = await submitCommand(text, scope || undefined);
      if (response.status === "dispatched") {
        const delivered = response.results.filter((r) => r.dispatched).length;
        const total = response.results.length;
        const isStreaming = response.resolved.action === "network_diagnostic";
        append({
          role: "system",
          tone: delivered === total ? "success" : "pending",
          text: isStreaming
            ? `Running ${response.resolved.params.tool} on ${delivered}/${total} device(s)…`
            : `Dispatched ${response.resolved.action} to ${delivered}/${total} device(s): ${response.results.map((r) => r.agentId).join(", ")}.`,
          reasoning: response.reasoning,
          streamTargets: isStreaming
            ? response.results.filter((r) => r.dispatched).map((r) => ({ commandId: r.commandId, agentId: r.agentId }))
            : undefined,
        });
      } else if (response.status === "needs_confirmation" && "kind" in response && response.kind === "erp") {
        // Asset Management ERP — ดู security/erpGuardrail.ts รูปแบบระบุ
        // เป้าหมายเป็นชื่อเหมือน branch ของ admin ด้านล่าง แต่แยก
        // pending-ID เป็นคนละชุด
        append({
          role: "system",
          tone: "pending",
          text: `This needs confirmation before it runs: ${response.reason}`,
          reasoning: response.reasoning,
        });
        setPendingErp({ pendingId: response.pendingId, reason: response.reason, resolved: response.resolved });
      } else if (response.status === "needs_confirmation" && "kind" in response) {
        // จัดการ org/user — ดู security/adminGuardrail.ts ระบุเป้าหมายเป็น
        // ชื่อแทนรายการอุปกรณ์ และ delete_organization มีช่องพิมพ์ยืนยัน
        // ชื่อของตัวเองด้านล่าง แทนปุ่มยืนยันธรรมดา
        append({
          role: "system",
          tone: "pending",
          text: `This needs confirmation before it runs: ${response.reason}`,
          reasoning: response.reasoning,
        });
        setDeleteOrgConfirmText("");
        setPendingAdmin({ pendingId: response.pendingId, reason: response.reason, resolved: response.resolved });
      } else if (response.status === "needs_confirmation") {
        append({
          role: "system",
          tone: "pending",
          text: `This needs confirmation before it runs: ${response.reason}`,
          reasoning: response.reasoning,
        });
        setPending({
          pendingId: response.pendingId,
          targets: response.targets,
          reason: response.reason,
          resolved: response.resolved,
        });
      } else if (response.status === "erp_form") {
        // ยังไม่มีการสร้างอะไรจริง เหมือน admin_form ด้านล่าง — แค่เปิด
        // VendorFormModal/PurchaseOrderFormModal ตัวเดียวกับที่หน้า
        // Vendors/Purchase Orders ใช้ พร้อมข้อมูลที่ดึงมาให้ล่วงหน้า
        append({
          role: "system",
          tone: "info",
          text:
            response.formAction === "create_vendor"
              ? "Opening the new-vendor form with what I could extract — review and submit when ready."
              : "Opening the new-purchase-order form with what I could extract — review and submit when ready.",
          reasoning: response.reasoning,
        });
        if (response.formAction === "create_vendor") setVendorPrefill(response.prefill);
        else setPoPrefill(response.prefill);
      } else if (response.status === "admin_form") {
        // ยังไม่มีการสร้างอะไรจริง — เปิด modal ตัวเดียวกับที่คนกดปุ่ม
        // "Create organization"/"Add user" ใช้ (validate เหมือนเดิมทุก
        // อย่าง) เพียงแต่กรอกข้อมูลที่ดึงได้ให้ล่วงหน้า ผู้ใช้ยังต้อง
        // ตรวจสอบ/แก้ไข/กดส่งเองตามปกติ
        append({
          role: "system",
          tone: "info",
          text:
            response.formAction === "create_organization"
              ? "Opening the create-organization form with what I could extract — review and submit when ready."
              : "Opening the add-user form with what I could extract — review, set a password, and submit when ready.",
          reasoning: response.reasoning,
        });
        if (response.formAction === "create_organization") setCreateOrgPrefill(response.prefill);
        else setAddUserPrefill(response.prefill);
      } else if (response.status === "admin_result" && "resultAction" in response) {
        // generate_installer — ไม่มีอะไรต้องยืนยัน แค่ส่งปุ่มดาวน์โหลด
        // กลับมา โดยใช้ route ตัวติดตั้งตัวเดียวกับที่หน้า
        // Downloads/Organizations ใช้อยู่แล้ว
        append({
          role: "system",
          tone: "success",
          text: `Installer ready for "${response.orgName}".`,
          reasoning: response.reasoning,
          installer: { orgId: response.installerOrgId, subdomain: response.subdomain, ownOrg: response.ownOrg },
        });
      } else if (response.status === "admin_result") {
        // ในทางปฏิบัติเข้าถึงได้ผ่าน confirmCommand เท่านั้น ไม่ใช่ตรงนี้
        // — คงไว้เพื่อให้ครบทุก case ของ union CommandApiResponse (ดู
        // lib/types.ts)
        append({ role: "system", tone: "success", text: response.message });
      } else {
        // "answered" — คำถามแบบอ่านอย่างเดียว (หรือคำขอที่จับคู่กับ action
        // ใดไม่ได้เลย ดู `fallback`) ไม่มีการส่งคำสั่งไปที่ไหน มีแค่
        // ข้อความคำตอบเฉยๆ
        append({
          role: "system",
          tone: response.answerable ? "info" : "pending",
          text: response.fallback
            ? `Couldn't map this to an exact command, so here's the device's current status instead:\n\n${response.answer}`
            : response.answer,
          reasoning: response.reasoning,
        });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unexpected error contacting the server.";
      append({ role: "system", tone: "error", text: message });
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const response = await confirmCommand(pending.pendingId);
      if (response.status === "dispatched") {
        const delivered = response.results.filter((r) => r.dispatched).length;
        append({
          role: "system",
          tone: "success",
          text: `Confirmed. Dispatched to ${delivered}/${response.results.length} device(s).`,
        });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unexpected error confirming the command.";
      append({ role: "system", tone: "error", text: message });
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  function handleCancel(): void {
    setPending(null);
    append({ role: "system", tone: "info", text: "Cancelled — nothing was sent." });
  }

  async function handleConfirmAdmin(): Promise<void> {
    if (!pendingAdmin || busy) return;
    setBusy(true);
    try {
      const response = await confirmCommand(pendingAdmin.pendingId);
      if (response.status === "admin_result" && "message" in response) {
        append({ role: "system", tone: "success", text: response.message });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unexpected error confirming the command.";
      append({ role: "system", tone: "error", text: message });
    } finally {
      setPendingAdmin(null);
      setBusy(false);
    }
  }

  function handleCancelAdmin(): void {
    setPendingAdmin(null);
    append({ role: "system", tone: "info", text: "Cancelled — nothing was sent." });
  }

  async function handleConfirmErp(): Promise<void> {
    if (!pendingErp || busy) return;
    setBusy(true);
    try {
      const response = await confirmCommand(pendingErp.pendingId);
      if (response.status === "admin_result" && "message" in response) {
        append({ role: "system", tone: "success", text: response.message });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unexpected error confirming the command.";
      append({ role: "system", tone: "error", text: message });
    } finally {
      setPendingErp(null);
      setBusy(false);
    }
  }

  function handleCancelErp(): void {
    setPendingErp(null);
    append({ role: "system", tone: "info", text: "Cancelled — nothing was sent." });
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-ink-primary">AI command console</h2>
            <p className="text-xs text-ink-muted">Natural-language fleet commands, parsed and guarded server-side.</p>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Target
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-md border border-border bg-page px-2 py-1 text-xs text-ink-primary outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All devices</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentId}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map((msg) => (
          <div key={msg.id} className={msg.role === "user" ? "flex flex-col items-end" : "flex flex-col items-start"}>
            <div
              className={
                msg.role === "user"
                  ? "max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm text-white"
                  : `max-w-[85%] rounded-lg border border-border px-3 py-2 text-sm ${TONE_CLASS[msg.tone ?? "info"]}`
              }
            >
              {msg.reasoning && (
                <p className="mb-1 border-b border-border/60 pb-1 text-[11px] italic text-ink-muted">AI understood: {msg.reasoning}</p>
              )}
              <p className="whitespace-pre-line">{msg.text}</p>
              {msg.streamTargets && msg.streamTargets.length > 0 && (
                <div className="mt-2 space-y-2">
                  {msg.streamTargets.map((t) => {
                    const out = commandOutputs?.[t.commandId];
                    return (
                      <div key={t.commandId} className="rounded-md border border-border/60 bg-page/60 p-2">
                        <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                          <span>{t.agentId}</span>
                          {out?.done ? (
                            <span className={out.error ? "text-status-critical" : "text-status-good"}>
                              {out.error ? "error" : "done"}
                            </span>
                          ) : (
                            <span className="text-status-warning">streaming…</span>
                          )}
                        </div>
                        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-ink-primary">
                          {out?.lines.length ? out.lines.join("\n") : "waiting for output…"}
                        </pre>
                        {out?.error && <p className="mt-1 text-xs text-status-critical">{out.error}</p>}
                      </div>
                    );
                  })}
                </div>
              )}
              {msg.installer && (
                <button
                  type="button"
                  onClick={() =>
                    msg.installer!.ownOrg ? downloadAgentInstaller() : downloadOrgInstaller(msg.installer!.orgId, msg.installer!.subdomain)
                  }
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
                >
                  <span className="material-symbols-outlined text-[16px]">download</span>
                  Download installer
                </button>
              )}
            </div>
            {msg.meta && <p className="mt-0.5 px-1 text-[11px] text-ink-muted">{msg.meta}</p>}
          </div>
        ))}
        {busy && <p className="text-xs text-ink-muted">Working…</p>}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. close the hung antivirus scanner on Admin-01"
          disabled={busy}
          className="flex-1 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          Send
        </button>
      </form>

      <ConfirmDialog
        open={pending !== null}
        title="Confirm this action?"
        message={pending ? `${pending.reason}\n\nAction: ${pending.resolved.action} · Targets: ${pending.targets.join(", ")}` : ""}
        confirmLabel="Confirm & send"
        tone="danger"
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      {/* ยืนยันแบบใช่/ไม่ใช่เหมือน dialog ของอุปกรณ์ด้านบน ใช้กับทุก action
          ของ admin ยกเว้น delete_organization ที่มีช่องพิมพ์ยืนยันชื่อ
          เข้มงวดกว่าด้านล่าง ตามแบบ DeleteOrgModal ของหน้า Organizations
          (action เดียวที่ย้อนกลับไม่ได้จริงๆ) */}
      <ConfirmDialog
        open={pendingAdmin !== null && pendingAdmin.resolved.action !== "delete_organization"}
        title="Confirm this action?"
        message={pendingAdmin ? pendingAdmin.reason : ""}
        confirmLabel="Confirm"
        tone="warning"
        busy={busy}
        onConfirm={handleConfirmAdmin}
        onCancel={handleCancelAdmin}
      />

      {pendingAdmin && pendingAdmin.resolved.action === "delete_organization" && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button type="button" aria-label="Dismiss" onClick={handleCancelAdmin} className="absolute inset-0 bg-black/40" />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-status-critical/30 bg-surface p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-status-critical">Delete "{pendingAdmin.resolved.orgName}"</h2>
            <p className="mt-2 text-xs text-ink-secondary">{pendingAdmin.reason}</p>
            <label className="mt-4 block text-xs text-ink-secondary">
              Type <span className="font-mono font-semibold text-ink-primary">{pendingAdmin.resolved.orgName}</span> to confirm
              <input
                autoFocus
                value={deleteOrgConfirmText}
                onChange={(e) => setDeleteOrgConfirmText(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-status-critical disabled:opacity-50"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={handleCancelAdmin} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmAdmin}
                disabled={busy || deleteOrgConfirmText !== pendingAdmin.resolved.orgName}
                className="rounded-md bg-status-critical px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingErp !== null}
        title="Confirm this action?"
        message={pendingErp ? pendingErp.reason : ""}
        confirmLabel="Confirm"
        tone="warning"
        busy={busy}
        onConfirm={handleConfirmErp}
        onCancel={handleCancelErp}
      />

      {vendorPrefill && (
        <VendorFormModal
          prefill={vendorPrefill}
          onClose={() => setVendorPrefill(null)}
          onSaved={() => {
            setVendorPrefill(null);
            append({ role: "system", tone: "success", text: "Vendor created." });
          }}
        />
      )}

      {poPrefill && (
        <PurchaseOrderFormModal
          prefill={poPrefill}
          onClose={() => setPoPrefill(null)}
          onCreated={() => {
            setPoPrefill(null);
            append({ role: "system", tone: "success", text: "Purchase order created." });
          }}
        />
      )}

      {createOrgPrefill && (
        <CreateOrgModal
          prefill={createOrgPrefill}
          onClose={() => setCreateOrgPrefill(null)}
          onCreated={() => {
            setCreateOrgPrefill(null);
            append({ role: "system", tone: "success", text: "Organization created." });
          }}
        />
      )}

      {addUserPrefill && (
        <AddUserModal
          prefill={addUserPrefill}
          onClose={() => setAddUserPrefill(null)}
          onCreated={() => {
            setAddUserPrefill(null);
            append({ role: "system", tone: "success", text: "User created." });
          }}
        />
      )}
    </div>
  );
}
