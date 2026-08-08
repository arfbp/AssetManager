// Short-lived, one-time-use store for guardrail verdicts that require human
// confirmation before dispatch. A dashboard operator reviews the resolved
// command and target list, then confirms via POST /api/command/:id/confirm
// — this is the human-in-the-loop step for anything the guardrail flagged
// as destructive-tier or mass-scope (see security/guardrail.ts).
import { randomUUID } from "node:crypto";
import type { ResolvedCommand } from "../security/guardrail.js";

export interface PendingAction {
  id: string;
  resolved: ResolvedCommand;
  targets: string[];
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export class PendingActionStore {
  private readonly store = new Map<string, PendingAction>();

  create(input: Omit<PendingAction, "id" | "createdAt">): PendingAction {
    this.sweep();
    const action: PendingAction = { ...input, id: randomUUID(), createdAt: Date.now() };
    this.store.set(action.id, action);
    return action;
  }

  /** Retrieves and removes the pending action — confirmation is one-time-use, never replayable. */
  take(id: string): PendingAction | null {
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
