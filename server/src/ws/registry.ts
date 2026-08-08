// In-memory registry of agents. A single-process registry is the right
// starting point for one server instance; scaling to multiple server
// processes needs a shared registry (e.g. Redis) behind this same interface
// — see server/README.md's "Scaling beyond one instance" note.
//
// Agents are never fully deleted on disconnect — they flip to status
// "offline" and keep their last-known telemetry. That's what lets the
// dashboard show a device that's currently unreachable instead of it just
// vanishing from the list, which matters for an ops/monitoring surface more
// than raw memory thrift (a fleet has a bounded, known device count).
//
// Every lookup/mutation here takes an orgId alongside agentId — agentId
// alone is just the machine's OS hostname (see cmd/agent/main.go's
// os.Hostname()), which is not unique across customer organizations
// ("DESKTOP-001" is a common auto-generated Windows hostname). The internal
// Map key is the composite of the two (mapKey below) so two different orgs'
// agents that happen to share a hostname coexist safely instead of one
// silently overwriting the other's connection state.
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { log } from "../logger.js";
import type { CommandOutputPayload, CommandPayload, ConfigUpdatePayload, SelfUpdatePayload, TelemetrySnapshot } from "../protocol.js";

export type AgentStatus = "online" | "offline";

export interface AgentSummary {
  orgId: string;
  agentId: string;
  status: AgentStatus;
  connectedAt: number;
  lastSeenAt: number;
  lastTelemetry: TelemetrySnapshot | null;
  /** The IP the current (or most recent) WebSocket connection came from —
   * see ws/server.ts's connection handler. Null only for an agent this
   * server process has never actually seen connect (e.g. restored from DB
   * on startup before persistence.ts is wired — see registry construction). */
  remoteIp: string | null;
  /** From the agent's own heartbeat (internal/version.Version) — null for an
   * agent build old enough to predate version reporting, or one that
   * hasn't sent a heartbeat yet this connection. Compared against the
   * server's own "latest available" build (see index.ts's
   * agentBuilds.ts's AgentBuildRegistry.getActive()) to decide whether to
   * push a self_update. */
  version: string | null;
  /** From the agent's own heartbeat (SHA256 of its live agent.yaml — see
   * internal/configpush) — null for an agent build old enough to predate
   * config-hash reporting, or one that hasn't sent a heartbeat yet this
   * connection. Compared against the server's own desired config (see
   * agentConfig.ts's loadDesiredAgentConfig) to decide whether to push a
   * config_update. */
  configHash: string | null;
}

interface AgentConnection extends AgentSummary {
  socket: WebSocket | null;
  /** Set once a self_update has been pushed for the CURRENTLY-reported
   * version on this connection, so a reconnect-free agent that's slow to
   * apply the update (or one whose update legitimately failed) doesn't get
   * re-sent the same instruction on every single heartbeat. Cleared
   * whenever the agent's reported version actually changes. */
  updateOfferedForVersion: string | null;
  /** Same reasoning as updateOfferedForVersion, for config_update pushes —
   * cleared whenever the agent's reported configHash actually changes. */
  configUpdateOfferedForHash: string | null;
}

function mapKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

function toSummary(c: AgentConnection): AgentSummary {
  return {
    orgId: c.orgId,
    agentId: c.agentId,
    status: c.status,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    lastTelemetry: c.lastTelemetry,
    remoteIp: c.remoteIp,
    version: c.version,
    configHash: c.configHash,
  };
}

/**
 * Emits "update" with an {@link AgentSummary} on every state change
 * (connect, disconnect, heartbeat, telemetry) — the dashboard WebSocket
 * server (ws/dashboardServer.ts) subscribes to this to push live updates to
 * connected browser clients without polling.
 */
export class AgentRegistry extends EventEmitter {
  private readonly agents = new Map<string, AgentConnection>();

  register(orgId: string, agentId: string, socket: WebSocket, remoteIp: string | null): void {
    const key = mapKey(orgId, agentId);
    const existing = this.agents.get(key);
    if (existing?.socket && existing.socket !== socket) {
      // A new connection from the same agent ID replaces the old one — the
      // stale socket is closed rather than left as an orphaned zombie entry.
      log.warn({ orgId, agentId }, "registry: replacing existing connection for agent");
      existing.socket.close(1000, "superseded by new connection");
    }
    const now = Date.now();
    const conn: AgentConnection = {
      orgId,
      agentId,
      status: "online",
      socket,
      connectedAt: now,
      lastSeenAt: now,
      lastTelemetry: existing?.lastTelemetry ?? null, // carry over last-known telemetry across a reconnect
      remoteIp: remoteIp ?? existing?.remoteIp ?? null,
      version: existing?.version ?? null,
      updateOfferedForVersion: existing?.updateOfferedForVersion ?? null,
      configHash: existing?.configHash ?? null,
      configUpdateOfferedForHash: existing?.configUpdateOfferedForHash ?? null,
    };
    this.agents.set(key, conn);
    this.emit("update", toSummary(conn));
  }

  unregister(orgId: string, agentId: string, socket: WebSocket): void {
    const key = mapKey(orgId, agentId);
    const existing = this.agents.get(key);
    // Only flip to offline if this call is for the currently-registered
    // socket — an old connection's close event firing after a reconnect
    // must not mark the new connection offline.
    if (existing && existing.socket === socket) {
      existing.status = "offline";
      existing.socket = null;
      this.emit("update", toSummary(existing));
    }
  }

  touch(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) {
      conn.lastSeenAt = Date.now();
      this.emit("update", toSummary(conn));
    }
  }

  /** Records the agent's self-reported version from a heartbeat — see
   * AgentSummary.version. Resets updateOfferedForVersion whenever the
   * reported version actually changes (a fresh version means any past
   * "already offered" tracking no longer applies to it). */
  recordVersion(orgId: string, agentId: string, version: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn && conn.version !== version) {
      conn.version = version;
      conn.updateOfferedForVersion = null;
      this.emit("update", toSummary(conn));
    }
  }

  /** True if this connection isn't running latestVersion and hasn't already
   * been offered an update for its current version.
   *
   * Deliberately an inequality check, not "is older than" — version
   * strings here are opaque (internal/version.Version, hand-bumped, not
   * parsed as semver), and the fleet's convergence model is "whatever
   * build sits in the server's downloads/ folder is authoritative,"
   * matching every agent to it either direction. That's what makes a
   * deliberate rollback possible: put an older build back in downloads/,
   * restart the server, and every agent downgrades to match — a real,
   * useful capability, not just a side effect to guard against. The real
   * guard here is updateOfferedForVersion: it stops the same self_update
   * from being re-sent on every heartbeat while one's already mid-flight or
   * has failed once (which needs a human to look at logs, not a retry
   * storm) — never a version-ordering check.
   */
  needsUpdate(orgId: string, agentId: string, latestVersion: string): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn || !conn.version) return false;
    return conn.version !== latestVersion && conn.updateOfferedForVersion !== conn.version;
  }

  markUpdateOffered(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) conn.updateOfferedForVersion = conn.version;
  }

  /** Records the agent's self-reported config hash from a heartbeat — see
   * AgentSummary.configHash. Resets configUpdateOfferedForHash whenever the
   * reported hash actually changes, same reasoning as recordVersion. */
  recordConfigHash(orgId: string, agentId: string, configHash: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn && conn.configHash !== configHash) {
      conn.configHash = configHash;
      conn.configUpdateOfferedForHash = null;
      this.emit("update", toSummary(conn));
    }
  }

  /** Same convergence reasoning as needsUpdate — an inequality check against
   * the server's desired config hash, not "older than" (config hashes have
   * no ordering at all). configUpdateOfferedForHash is the real guard here,
   * same as needsUpdate's updateOfferedForVersion. */
  needsConfigUpdate(orgId: string, agentId: string, desiredHash: string): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn || !conn.configHash) return false;
    return conn.configHash !== desiredHash && conn.configUpdateOfferedForHash !== conn.configHash;
  }

  markConfigUpdateOffered(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) conn.configUpdateOfferedForHash = conn.configHash;
  }

  recordTelemetry(orgId: string, agentId: string, snapshot: TelemetrySnapshot): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) {
      conn.lastTelemetry = snapshot;
      conn.lastSeenAt = Date.now();
      this.emit("update", toSummary(conn));
      // Distinct from "update" so a durable-storage listener (db/persistence.ts)
      // can append one time-series row per snapshot without re-deriving that
      // from a generic state-change event that also fires on plain heartbeats.
      this.emit("telemetry", { orgId, agentId, snapshot });
    }
  }

  /**
   * Relays one incremental chunk of a streaming command's output (e.g. one
   * tracert hop) to whatever's listening for it — the dashboard WebSocket
   * server (ws/dashboardServer.ts) forwards this straight to browser clients
   * so a running network_diagnostic renders line-by-line instead of only
   * appearing once the whole command finishes. Distinct from "update"/
   * "telemetry": this isn't agent state, it's a transient event with no
   * corresponding stored value in AgentConnection.
   */
  recordCommandOutput(orgId: string, agentId: string, payload: CommandOutputPayload): void {
    this.emit("command_output", { orgId, agentId, payload });
  }

  // Warm-starts this in-memory registry from durable storage (Postgres's
  // agents table — see db/persistence.ts's loadPersistedAgents) right after
  // construction, before any real agent reconnects. Without this, every
  // server restart blanked lastTelemetry/remoteIp back to null until that
  // agent's next scheduled poll (up to 5 minutes on the normal interval) —
  // the dashboard's "Live" tab and the Asset Registry's CPU/RAM/storage/IP
  // columns all read lastTelemetry, so a restart made a perfectly healthy,
  // still-reporting device look like it had no data at all in the meantime.
  // Always seeded as "offline" with no socket, regardless of what the DB
  // said before the restart — this process hasn't actually seen a
  // connection yet, and register()'s own carry-over logic
  // (`existing?.lastTelemetry ?? null`) upgrades it to "online" with the
  // real socket the moment the agent's own reconnect (with backoff) lands,
  // same as it already does for a same-process reconnect.
  hydrate(agents: AgentSummary[]): void {
    for (const a of agents) {
      this.agents.set(mapKey(a.orgId, a.agentId), {
        ...a,
        status: "offline",
        socket: null,
        updateOfferedForVersion: null,
        configUpdateOfferedForHash: null,
      });
    }
  }

  isOnline(orgId: string, agentId: string): boolean {
    return this.agents.get(mapKey(orgId, agentId))?.status === "online";
  }

  /** Every connected/known agent across every org — callers that must not
   * leak across tenants (any dashboard-facing read) are responsible for
   * filtering the result by orgId themselves. Deliberately unfiltered here
   * so this class stays a plain connection-state store, not a place tenant
   * policy has to be duplicated for every future caller. */
  listAll(): AgentSummary[] {
    return [...this.agents.values()].map(toSummary);
  }

  getTelemetry(orgId: string, agentId: string): TelemetrySnapshot | null {
    return this.agents.get(mapKey(orgId, agentId))?.lastTelemetry ?? null;
  }

  /**
   * Sends a signed command to one agent. Returns false (does not throw) if
   * the agent isn't currently connected — callers decide whether an offline
   * target is a hard failure or something to report back to the caller.
   */
  sendCommand(orgId: string, agentId: string, command: CommandPayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "command", payload: command }));
    return true;
  }

  /** Sends a signed self_update instruction to one agent — same
   * connectivity check as sendCommand, but a structurally separate method
   * (not an overload) so it's never possible to pass a self_update through
   * whatever code path constructs CommandPayloads, or vice versa. */
  sendSelfUpdate(orgId: string, agentId: string, payload: SelfUpdatePayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "self_update", payload }));
    return true;
  }

  /** Sends a signed config_update instruction to one agent — same
   * connectivity check and same structural-isolation reasoning as
   * sendSelfUpdate. */
  sendConfigUpdate(orgId: string, agentId: string, payload: ConfigUpdatePayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "config_update", payload }));
    return true;
  }
}
