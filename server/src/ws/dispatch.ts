// เซ็นและส่งคำสั่งที่ resolve แล้วไปยัง target agent ทุกตัว แล้วรายงานกลับว่า
// ตัวไหนออนไลน์อยู่จริงจนได้รับคำสั่ง นี่คือจุดเดียวที่สร้าง signed
// CommandPayload — routes.ts ไม่เคยสร้างเองโดยตรง
import { randomUUID } from "node:crypto";
import { audit } from "../logger.js";
import { signCommand } from "../crypto/commandSigner.js";
import type { CommandPayload } from "../protocol.js";
import type { ResolvedCommand } from "../security/guardrail.js";
import type { AgentRegistry } from "./registry.js";
import type { CommandHistoryStore } from "../history/commandHistory.js";

export interface DispatchResult {
  agentId: string;
  dispatched: boolean;
  commandId: string;
}

export function dispatchToTargets(
  orgId: string,
  resolved: ResolvedCommand,
  targets: string[],
  registry: AgentRegistry,
  history: CommandHistoryStore,
  hmacSecret: string,
  requestedBy: string,
  sourceText: string | null = null,
): DispatchResult[] {
  const issuedAtUnix = Math.floor(Date.now() / 1000);

  return targets.map((agentId) => {
    const commandId = randomUUID();
    const unsigned = { id: commandId, action: resolved.action, params: resolved.params, issuedAtUnix };
    const payload: CommandPayload = {
      id: commandId,
      action: resolved.action,
      params: resolved.params,
      issued_at_unix: issuedAtUnix,
      signature: signCommand(unsigned, hmacSecret),
    };

    const dispatched = registry.sendCommand(orgId, agentId, payload);
    audit.info(
      { orgId, agentId, commandId, action: resolved.action, params: resolved.params, dispatched, requestedBy },
      dispatched ? "dispatch: command sent" : "dispatch: agent offline, command not delivered",
    );
    history.recordDispatch(
      {
        commandId,
        orgId,
        agentId,
        action: resolved.action,
        params: resolved.params,
        requestedBy,
        sourceText,
        dispatchedAt: Date.now(),
      },
      dispatched,
    );

    return { agentId, dispatched, commandId };
  });
}
