"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ApiError, confirmCommand, submitCommand } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import type { AgentSummary, HistoryEntry, HistoryEntryStatus } from "@/lib/types";
import type { StreamedCommandOutput } from "@/hooks/useDashboardSocket";

interface ChatMessage {
  id: string;
  role: "user" | "system";
  text: string;
  tone?: "info" | "success" | "error" | "pending";
  // What the model understood the request to mean, shown as a small
  // secondary line so the operator can see the interpreted intent, not
  // just the outcome.
  reasoning?: string;
  // Set only for a dispatched network_diagnostic (ping/tracert/nslookup/
  // netstat) — one entry per device it went to. Rendered live from the
  // commandOutputs prop, which updates as chunks arrive over the dashboard
  // WebSocket, so the operator sees hops/replies appear one at a time
  // instead of waiting for the whole command to finish.
  streamTargets?: { commandId: string; agentId: string }[];
  // Who sent it and when — set only on entries reconstructed from durable
  // server-side history (see buildHistoryMessages), so past sessions still
  // show the same audit trail as command_history/"Recent activity". Not set
  // on messages from the current live session — there, "who" is implicitly
  // the operator currently typing.
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

// Reconstructs past console turns from the durable command_history table
// (the same data "Recent activity" and the drawer's "Commands" tab read
// from) so re-opening this console shows what was already sent to this
// device rather than starting blank every time — every entry already
// carries who sent it (server-derived requestedBy, never client-supplied).
// Scoped to a single device (not the live scope dropdown, which can be
// changed to target something else without rewriting past history) and
// capped to the most recent entries so an old, busy device doesn't dump an
// unbounded wall of text into the panel.
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
  // Preselects the device dropdown (e.g. when embedded in a specific
  // device's drawer) — the dropdown still lets the operator switch to
  // another device or back to "All devices" for a group command. Also used
  // to seed past turns for this device from durable history (see
  // buildHistoryMessages) — switching the dropdown later doesn't reseed.
  defaultScope?: string;
  // Fleet-wide dispatched-command history (from useDashboardSocket) — used
  // only to seed this device's past console turns on mount, same source
  // "Recent activity" and the drawer's "Commands" tab already read from.
  history?: HistoryEntry[];
  // Live streamed output for in-flight network_diagnostic commands, keyed
  // by commandId — from useDashboardSocket(). Undefined/missing entries
  // just render as "waiting for output…" until the first chunk arrives.
  commandOutputs?: Record<string, StreamedCommandOutput>;
}

/**
 * Natural-language command console. Every submission goes through the
 * server's LLM parser + security guardrail (POST /api/command) — this
 * component only renders whatever the server decided (dispatched / needs
 * confirmation / blocked). It never constructs or sends a command directly.
 *
 * The device selector is optional — leaving it on "All devices" falls back
 * to the model extracting scope from the sentence itself (group commands
 * like "clean temp on the accounting group" need this, since there's no
 * single device to preselect). Picking one specific device instead sends it
 * straight through as an override (see routes.ts's CommandRequestSchema),
 * which is both a UX shortcut and a reliability fix — the model has
 * misread which device a sentence meant more than once in this project.
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follows the conversation as it grows — new turns from typing a command,
  // and streamed network_diagnostic output arriving chunk by chunk both
  // push content in below the fold, so this re-runs on either.
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
      } else {
        // "answered" — a read-only question (or a request that didn't map
        // to a specific action at all, see `fallback`); nothing was
        // dispatched anywhere, this is just the answer text.
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
    </div>
  );
}
