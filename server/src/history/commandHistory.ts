// Bounded in-memory log of dispatched commands and their outcomes, for the
// dashboard's "Command History" panel. A ring buffer (fixed max size) is
// enough for an operational view of recent activity; wire this into your
// real audit/log storage (see server/README.md) for anything that needs to
// survive a restart or be queried beyond the recent window.
import { EventEmitter } from "node:events";
import type { CommandAction } from "../protocol.js";

export type HistoryEntryStatus = "dispatched" | "offline" | "succeeded" | "failed";

export interface HistoryEntry {
  commandId: string;
  orgId: string;
  agentId: string;
  action: CommandAction;
  params: Record<string, string>;
  requestedBy: string;
  sourceText: string | null; // the original NL request, if this came from the chat console
  status: HistoryEntryStatus;
  message: string | null;
  dispatchedAt: number;
  resolvedAt: number | null;
}

const MAX_ENTRIES = 500;

/** Emits "entry" with a {@link HistoryEntry} on every insert or update. */
export class CommandHistoryStore extends EventEmitter {
  private entries: HistoryEntry[] = [];
  private readonly byId = new Map<string, HistoryEntry>();

  recordDispatch(entry: Omit<HistoryEntry, "status" | "message" | "resolvedAt">, delivered: boolean): void {
    const full: HistoryEntry = {
      ...entry,
      status: delivered ? "dispatched" : "offline",
      message: delivered ? null : "agent is offline; command was not delivered",
      resolvedAt: delivered ? null : Date.now(),
    };
    this.entries.push(full);
    this.byId.set(full.commandId, full);
    this.trim();
    this.emit("entry", full);
  }

  recordResult(commandId: string, success: boolean, message: string): void {
    const entry = this.byId.get(commandId);
    if (!entry) return; // result for a command dispatched before this process started, or already trimmed
    entry.status = success ? "succeeded" : "failed";
    entry.message = message;
    entry.resolvedAt = Date.now();
    this.emit("entry", entry);
  }

  recent(limit = 100): HistoryEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  // Warm-starts this in-memory store from durable storage (Postgres's
  // command_history table — see db/persistence.ts's loadRecentHistory) right
  // after construction, before any dashboard client connects. Without this,
  // every server restart silently blanked the live "who did what" view back
  // to empty — command_history itself was never affected (upsertHistoryEntry
  // already persisted everything correctly), only this operational,
  // memory-only copy the dashboard/AI console/Commands tab actually read
  // from. `entries` must arrive oldest-first, matching recordDispatch's own
  // push-to-end ordering, or recent()'s slice+reverse would return them
  // newest-first internally and backwards to callers.
  hydrate(entries: HistoryEntry[]): void {
    this.entries = entries.slice(-MAX_ENTRIES);
    this.byId.clear();
    for (const e of this.entries) this.byId.set(e.commandId, e);
  }

  private trim(): void {
    if (this.entries.length <= MAX_ENTRIES) return;
    const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    for (const e of removed) this.byId.delete(e.commandId);
  }
}
