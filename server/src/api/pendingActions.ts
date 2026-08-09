// Short-lived, one-time-use store for guardrail verdicts that require human
// confirmation before dispatch. A dashboard operator reviews the resolved
// command and target list, then confirms via POST /api/command/:id/confirm
// — this is the human-in-the-loop step for anything the guardrail flagged
// as destructive-tier or mass-scope (see security/guardrail.ts).
//
// Generic over the payload shape so the same TTL/sweep machinery backs two
// independent stores in routes.ts: one for device-targeted actions
// (PendingAction, unchanged) and one for admin actions (PendingAdminAction,
// see security/adminGuardrail.ts) — the two are never confirmable through
// each other's endpoint, kept as separate store instances entirely.
import { randomUUID } from "node:crypto";
import type { ResolvedCommand } from "../security/guardrail.js";
import type { ConfirmableAdminAction } from "../security/adminGuardrail.js";

export interface PendingAction {
  id: string;
  resolved: ResolvedCommand;
  targets: string[];
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

export interface PendingAdminAction {
  id: string;
  resolved: ConfirmableAdminAction;
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export class PendingActionStore<T extends { id: string; createdAt: number }> {
  private readonly store = new Map<string, T>();

  create(input: Omit<T, "id" | "createdAt">): T {
    this.sweep();
    const action = { ...input, id: randomUUID(), createdAt: Date.now() } as T;
    this.store.set(action.id, action);
    return action;
  }

  /** Retrieves and removes the pending action — confirmation is one-time-use, never replayable. */
  take(id: string): T | null {
    this.sweep();
    const action = this.store.get(id);
    if (!action) return null;
    this.store.delete(id);
    return action;
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, action] of this.store) {
      if (action.createdAt < cutoff) this.store.delete(id);
    }
  }
}
