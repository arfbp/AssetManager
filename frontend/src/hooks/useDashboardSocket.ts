"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentSummary, CommandOutputPayload, DashboardWsMessage, HistoryEntry } from "@/lib/types";
import { getToken } from "@/lib/session";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

export type ConnectionStatus = "connecting" | "open" | "closed";

// Accumulated state for one streamed network_diagnostic command, keyed by
// commandId — ChatConsole reads this to render output as it arrives rather
// than waiting for the final command_result.
export interface StreamedCommandOutput {
  lines: string[];
  done: boolean;
  error?: string;
}

export interface DashboardState {
  agents: AgentSummary[];
  history: HistoryEntry[];
  connectionStatus: ConnectionStatus;
  commandOutputs: Record<string, StreamedCommandOutput>;
}

const MAX_HISTORY = 200;
// Bounds memory for a long-lived dashboard tab — old streamed commands are
// evicted oldest-first once this many distinct commandIds have been seen.
const MAX_TRACKED_COMMAND_OUTPUTS = 50;

function appendCommandOutput(
  existing: Record<string, StreamedCommandOutput>,
  chunk: CommandOutputPayload,
): Record<string, StreamedCommandOutput> {
  const prior = existing[chunk.command_id];
  const next: StreamedCommandOutput = {
    lines: chunk.line ? [...(prior?.lines ?? []), chunk.line] : (prior?.lines ?? []),
    done: chunk.done,
    error: chunk.error ?? prior?.error,
  };
  const merged = { ...existing, [chunk.command_id]: next };

  const ids = Object.keys(merged);
  if (ids.length > MAX_TRACKED_COMMAND_OUTPUTS) {
    // Insertion order on a plain object is stable for string keys here, so
    // the earliest-seen commandIds are the oldest — evict those first.
    for (const staleId of ids.slice(0, ids.length - MAX_TRACKED_COMMAND_OUTPUTS)) {
      delete merged[staleId];
    }
  }
  return merged;
}

function upsertHistory(existing: HistoryEntry[], incoming: HistoryEntry): HistoryEntry[] {
  const idx = existing.findIndex((e) => e.commandId === incoming.commandId);
  if (idx === -1) {
    return [incoming, ...existing].slice(0, MAX_HISTORY);
  }
  const copy = existing.slice();
  copy[idx] = incoming;
  return copy;
}

// A dropped WebSocket connection mid-command (common on a flaky network —
// this is the same class of gap the connCtx/execCtx agent-side fix closed,
// just on the dashboard side instead) silently loses whatever
// "command_output" events arrived while disconnected, including the one
// terminal chunk that sets done: true — verified live with a Software
// Deploy run that had genuinely finished (command_history showed
// "succeeded" within two minutes) while the tab stayed stuck showing
// "Installing… 92%" indefinitely, because that one chunk never arrived and
// nothing ever re-checked. history_entry/snapshot come over the same
// socket but are backed by the durable command_history row in Postgres,
// not the live per-line stream, so they always eventually carry the real
// outcome even when a line was missed — this patches commandOutputs from
// them wherever a command has resolved but its streamed record never
// caught up, so any stuck progress bar heals itself the moment the next
// history update (a snapshot on reconnect, or a live history_entry) arrives.
function reconcileCommandOutputsFromHistory(
  outputs: Record<string, StreamedCommandOutput>,
  entries: HistoryEntry[],
): Record<string, StreamedCommandOutput> {
  let changed = false;
  let next = outputs;
  for (const entry of entries) {
    if (entry.status === "dispatched") continue; // not resolved yet, nothing to reconcile
    if (next[entry.commandId]?.done) continue; // streaming already delivered the real completion
    if (next === outputs) next = { ...outputs };
    next[entry.commandId] = {
      lines: next[entry.commandId]?.lines ?? [],
      done: true,
      error: entry.status === "succeeded" ? undefined : (entry.message ?? `command ${entry.status}`),
    };
    changed = true;
  }
  return changed ? next : outputs;
}

/**
 * Owns the live connection to the dashboard WebSocket
 * (server/src/ws/dashboardServer.ts): agent status/telemetry and command
 * history arrive as push updates, no polling. Reconnects with capped
 * exponential backoff on any drop.
 */
export function useDashboardSocket(): DashboardState {
  const [agentsById, setAgentsById] = useState<Record<string, AgentSummary>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [commandOutputs, setCommandOutputs] = useState<Record<string, StreamedCommandOutput>>({});
  const retryDelayRef = useRef(1000);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect(): void {
      if (cancelled) return;
      setConnectionStatus("connecting");

      // Token travels as a WebSocket subprotocol, not a query param — a
      // query-string token ends up written in full into nginx's (and any
      // other proxy's) access log on every connect, since standard access-
      // log formats record the whole request line including the query
      // string. The subprotocol list becomes a Sec-WebSocket-Protocol
      // *header* instead, which access logs never see (see
      // server/src/ws/dashboardServer.ts's verifyClient for the other end).
      const url = `${WS_URL}/ws/dashboard`;
      socket = new WebSocket(url, [getToken()]);

      socket.onopen = () => {
        retryDelayRef.current = 1000; // reset backoff on a clean connect
        setConnectionStatus("open");
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let msg: DashboardWsMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // ignore malformed frames rather than crashing the UI
        }

        switch (msg.type) {
          case "snapshot": {
            const byId: Record<string, AgentSummary> = {};
            for (const agent of msg.agents) byId[agent.agentId] = agent;
            setAgentsById(byId);
            const snapshotHistory = msg.history.slice(0, MAX_HISTORY);
            setHistory(snapshotHistory);
            setCommandOutputs((prev) => reconcileCommandOutputsFromHistory(prev, snapshotHistory));
            break;
          }
          case "agent_update": {
            setAgentsById((prev) => ({ ...prev, [msg.agent.agentId]: msg.agent }));
            break;
          }
          case "history_entry": {
            setHistory((prev) => upsertHistory(prev, msg.entry));
            setCommandOutputs((prev) => reconcileCommandOutputsFromHistory(prev, [msg.entry]));
            break;
          }
          case "command_output": {
            setCommandOutputs((prev) => appendCommandOutput(prev, msg.output));
            break;
          }
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnectionStatus("closed");
        const delay = Math.min(retryDelayRef.current, 30_000);
        retryDelayRef.current = delay * 2;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const agents = Object.values(agentsById).sort((a, b) => a.agentId.localeCompare(b.agentId));

  return { agents, history, connectionStatus, commandOutputs };
}
