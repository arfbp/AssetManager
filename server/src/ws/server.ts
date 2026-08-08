// WebSocket hub for many concurrent agent connections. Handles auth,
// heartbeat-based dead-connection reaping, and dispatching inbound
// telemetry/heartbeat/command_result/alert messages to the registry and logs.
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync, createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { Config } from "../config.js";
import { log, audit } from "../logger.js";
import { AgentRegistry } from "./registry.js";
import type { CommandHistoryStore } from "../history/commandHistory.js";
import type {
  AlertPayload,
  CommandOutputPayload,
  CommandResultPayload,
  ConfigUpdatePayload,
  Envelope,
  HeartbeatPayload,
  SelfUpdatePayload,
  TelemetryPayload,
} from "../protocol.js";
import { notifyAll } from "../notifications/dispatcher.js";
import type { NotifyConfig } from "../notifications/types.js";
import type { AgentBuildRegistry } from "../agentBuilds.js";
import type { DesiredAgentConfig } from "../agentConfig.js";
import { signSelfUpdate, signConfigUpdate } from "../crypto/commandSigner.js";
import type { OrgCredentialCache, OrgCredential } from "../orgs/orgCredentials.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 256 * 1024; // one telemetry snapshot is small; this is a generous ceiling against abuse

interface ConnState {
  agentId: string | null;
  isAlive: boolean;
  remoteIp: string | null;
  // Resolved once at connect time from the presented bearer token (see
  // resolveOrgByAgentToken below) and held for the connection's lifetime —
  // a rotated secret only takes effect on the agent's next reconnect, same
  // "connection-lifetime cache" tradeoff as OrgCredentialCache itself.
  orgId: string;
  hmacSecret: string;
}

// Every agent (and every plain-HTTP download route below) used to compare
// against one fleet-wide OPTIFLEET_AGENT_AUTH_TOKEN string — now each
// presented token is looked up against every organization's own token, so a
// customer's own agents authenticate with credentials no other org holds.
// Centralized here since the same check used to be copy-pasted 3 times
// (verifyClient, /agent-download/exe, /agent-download/custom/:id).
function resolveOrgByAgentToken(credentials: OrgCredentialCache, authHeader: string | undefined): OrgCredential | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  if (!token) return null;
  return credentials.resolveByToken(token);
}

export function startWsServer(
  cfg: Config,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  buildRegistry: AgentBuildRegistry,
  desiredConfig: DesiredAgentConfig | null,
  credentials: OrgCredentialCache,
): WebSocketServer {
  const httpOrHttps: HttpServer | HttpsServer =
    cfg.ws.tlsCertPath && cfg.ws.tlsKeyPath
      ? createHttpsServer({
          cert: readFileSync(cfg.ws.tlsCertPath),
          key: readFileSync(cfg.ws.tlsKeyPath),
        })
      : createHttpServer();

  if (!cfg.ws.tlsCertPath) {
    log.warn(
      "ws: no TLS cert configured — serving plaintext ws:// (dev only; config.ts refuses this in production)",
    );
  }

  // Plain HTTP GET on the SAME listener the WebSocket upgrade lives on —
  // agents already trust this exact host:port:cert (it's what they dial for
  // their own connection), so self-update fetches from here rather than
  // needing a second address/cert an agent would have to be separately
  // configured to trust. Node's http(s).Server only routes upgrade
  // requests to the WebSocketServer; every other request still reaches this
  // plain "request" handler untouched.
  httpOrHttps.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }

    if (req.url === "/agent-download/exe") {
      if (!resolveOrgByAgentToken(credentials, req.headers["authorization"])) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const active = buildRegistry.getActive();
      if (!active) {
        res.writeHead(404).end("no build available");
        return;
      }
      // Content-Length lets a downloading script compute real download
      // progress (bytes-received / total) — without it a plain streamed
      // response has no advertised size, so a script has no way to turn
      // "some bytes arrived" into a percentage. See the Software Deploy
      // page's generated scripts.
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(active.exePath).size });
      createReadStream(active.exePath).pipe(res);
      return;
    }

    // Same per-org bearer-token trust as /agent-download/exe above (the
    // token this agent's own org holds, not a per-request secret) — see
    // api/routes.ts's POST /software-uploads for how `id` gets there.
    // path.basename strips any directory component from the URL segment
    // before it ever touches the filesystem, so this can only ever resolve
    // to a file directly inside THIS org's own subdirectory of
    // customInstallersDir, never anywhere else on disk — and, since the org
    // is resolved fresh from the presented token on every request (not
    // trusted from the URL), never another org's subdirectory either, even
    // if that org's own random UUID-prefixed filename somehow leaked.
    if (req.url?.startsWith("/agent-download/custom/")) {
      const org = resolveOrgByAgentToken(credentials, req.headers["authorization"]);
      if (!org) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const id = path.basename(decodeURIComponent(req.url.slice("/agent-download/custom/".length)));
      const filePath = path.join(cfg.customInstallersDir, org.orgId, id);
      if (!id || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(filePath).size });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: httpOrHttps,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info, cb) => {
      const org = resolveOrgByAgentToken(credentials, info.req.headers["authorization"]);
      if (!org) {
        log.warn({ remote: info.req.socket.remoteAddress }, "ws: rejected connection, bad auth token");
        cb(false, 401, "unauthorized");
        return;
      }
      // ws's connection handler below receives this exact same `req`
      // object as its second argument — stashing the resolved org here is
      // the standard way to pass data from verifyClient forward, since
      // there's no other channel between the two.
      (info.req as IncomingMessage & { orgCredential?: OrgCredential }).orgCredential = org;
      cb(true);
    },
  });

  const connStates = new WeakMap<WebSocket, ConnState>();

  wss.on("connection", (socket, req) => {
    const remoteIp = normalizeIp(req.socket.remoteAddress);
    // Always set — verifyClient rejects the upgrade before this handler
    // ever runs if no org resolved, so this is never actually undefined.
    const org = (req as IncomingMessage & { orgCredential?: OrgCredential }).orgCredential!;
    const state: ConnState = { agentId: null, isAlive: true, remoteIp, orgId: org.orgId, hmacSecret: org.hmacSecret };
    connStates.set(socket, state);
    log.info({ remote: remoteIp, orgId: state.orgId }, "ws: agent connected (awaiting identification)");

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (raw: RawData) => {
      // A single malformed or adversarial message from one agent must never
      // take down the process for every other connected agent.
      try {
        handleMessage(socket, state, raw, registry, history, cfg.notifications, buildRegistry, desiredConfig, cfg.ws.publicHost);
      } catch (err) {
        log.warn({ agentId: state.agentId, err: (err as Error).message }, "ws: error handling inbound message, dropping it");
      }
    });

    socket.on("close", (code, reason) => {
      if (state.agentId) {
        registry.unregister(state.orgId, state.agentId, socket);
        log.info({ agentId: state.agentId, code, reason: reason.toString() }, "ws: agent disconnected");
      }
    });

    socket.on("error", (err) => {
      log.warn({ agentId: state.agentId, err: err.message }, "ws: connection error");
    });
  });

  // Reap dead connections: ping everyone every interval; anyone that didn't
  // pong since the last sweep is terminated. This is what keeps "many agents
  // connected at once, stable" true over hours/days rather than accumulating
  // half-dead sockets from network blips that never sent a close frame.
  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      const state = connStates.get(socket);
      if (!state) continue;
      if (!state.isAlive) {
        log.warn({ agentId: state.agentId }, "ws: no pong since last sweep, terminating connection");
        socket.terminate();
        continue;
      }
      state.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeatTimer));

  httpOrHttps.listen(cfg.ws.port, () => {
    log.info({ port: cfg.ws.port, tls: Boolean(cfg.ws.tlsCertPath) }, "ws: listening for agent connections");
  });

  return wss;
}

function handleMessage(
  socket: WebSocket,
  state: ConnState,
  raw: RawData,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  notifyCfg: NotifyConfig,
  buildRegistry: AgentBuildRegistry,
  desiredConfig: DesiredAgentConfig | null,
  publicHost: string,
): void {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw.toString());
  } catch {
    log.warn({ agentId: state.agentId }, "ws: dropping malformed envelope (not JSON)");
    return;
  }

  switch (envelope.type) {
    case "heartbeat": {
      const payload = envelope.payload as HeartbeatPayload;
      identifyIfNeeded(socket, state, payload.agent_id, registry);
      registry.touch(state.orgId, payload.agent_id);
      if (payload.version) {
        registry.recordVersion(state.orgId, payload.agent_id, payload.version);
        maybeOfferUpdate(registry, state.orgId, payload.agent_id, buildRegistry, state.hmacSecret, publicHost);
      }
      if (payload.config_hash) {
        registry.recordConfigHash(state.orgId, payload.agent_id, payload.config_hash);
        maybeOfferConfigUpdate(registry, state.orgId, payload.agent_id, desiredConfig, state.hmacSecret);
      }
      break;
    }
    case "telemetry": {
      const payload = envelope.payload as TelemetryPayload;
      if (!state.agentId) {
        log.warn("ws: telemetry received before agent identified itself, dropping");
        return;
      }
      registry.recordTelemetry(state.orgId, state.agentId, payload.snapshot);
      if (payload.snapshot.mode === "alert") {
        log.warn(
          { agentId: state.agentId, cpu: payload.snapshot.cpu_percent, mem: payload.snapshot.mem_percent },
          "ws: agent reporting alert-mode telemetry",
        );
      }
      break;
    }
    case "command_result": {
      const payload = envelope.payload as CommandResultPayload;
      audit.info({ agentId: state.agentId, ...payload }, "command_result received");
      history.recordResult(payload.command_id, payload.success, payload.message);
      break;
    }
    case "command_output": {
      const payload = envelope.payload as CommandOutputPayload;
      if (!state.agentId) {
        log.warn("ws: command_output received before agent identified itself, dropping");
        return;
      }
      registry.recordCommandOutput(state.orgId, state.agentId, payload);
      break;
    }
    case "alert": {
      const payload = envelope.payload as AlertPayload;
      audit.warn({ agentId: state.agentId, ...payload }, "self-heal alert received");
      if (state.agentId) {
        notifyAll(notifyCfg, { kind: payload.kind, agentId: state.agentId, message: payload.message, severity: "warning" });
      }
      break;
    }
    default:
      log.debug({ type: envelope.type }, "ws: ignoring unexpected message type");
  }
}

// The only place a self_update ever gets constructed and sent — see
// protocol.ts's SelfUpdatePayload doc comment for why this matters: nothing
// downstream of the AI console/guardrail can reach this function, it only
// ever fires from an agent's own heartbeat reporting an older version than
// what's on disk in downloads/. URL always points back at THIS SAME
// agent-hub listener (publicHost:cfg.ws.port), never anything
// server-supplied-per-request, so a compromised signing secret is the only
// way this could ever be redirected elsewhere.
function maybeOfferUpdate(
  registry: AgentRegistry,
  orgId: string,
  agentId: string,
  buildRegistry: AgentBuildRegistry,
  hmacSecret: string,
  publicHost: string,
): void {
  const active = buildRegistry.getActive();
  if (!active) return;
  if (!registry.needsUpdate(orgId, agentId, active.version)) return;

  const issuedAtUnix = Math.floor(Date.now() / 1000);
  const unsigned = { version: active.version, url: `https://${publicHost}/agent-download/exe`, sha256: active.sha256, issuedAtUnix };
  const payload: SelfUpdatePayload = {
    version: unsigned.version,
    url: unsigned.url,
    sha256: unsigned.sha256,
    issued_at_unix: issuedAtUnix,
    signature: signSelfUpdate(unsigned, hmacSecret),
  };

  if (registry.sendSelfUpdate(orgId, agentId, payload)) {
    registry.markUpdateOffered(orgId, agentId);
    audit.info({ orgId, agentId, toVersion: active.version }, "selfupdate: pushed to agent");
  }
}

// Same isolation reasoning as maybeOfferUpdate above: nothing downstream of
// the AI console/guardrail can reach this function, it only ever fires from
// an agent's own heartbeat reporting a config hash that doesn't match
// agentConfig.ts's desired config.
function maybeOfferConfigUpdate(
  registry: AgentRegistry,
  orgId: string,
  agentId: string,
  desiredConfig: DesiredAgentConfig | null,
  hmacSecret: string,
): void {
  if (!desiredConfig) return;
  if (!registry.needsConfigUpdate(orgId, agentId, desiredConfig.sha256)) return;

  const issuedAtUnix = Math.floor(Date.now() / 1000);
  const unsigned = {
    configYaml: desiredConfig.yaml,
    configSha256: desiredConfig.sha256,
    enableRunScript: desiredConfig.enableRunScript,
    issuedAtUnix,
  };
  const payload: ConfigUpdatePayload = {
    config_yaml: unsigned.configYaml,
    config_sha256: unsigned.configSha256,
    enable_run_script: unsigned.enableRunScript,
    issued_at_unix: issuedAtUnix,
    signature: signConfigUpdate(unsigned, hmacSecret),
  };

  if (registry.sendConfigUpdate(orgId, agentId, payload)) {
    registry.markConfigUpdateOffered(orgId, agentId);
    audit.info({ orgId, agentId, configSha256: desiredConfig.sha256 }, "configpush: pushed to agent");
  }
}

// The agent's first heartbeat or telemetry message is what tells us its
// identity (agent_id = hostname) — there's no separate handshake payload,
// matching how the Go agent's transport.Client is implemented. orgId comes
// from the connection itself (state.orgId, resolved once at connect time
// from the presented bearer token — see resolveOrgByAgentToken), never from
// anything agent-supplied, so a compromised/malicious agent has no way to
// claim membership in a different org than the credential it authenticated
// with actually belongs to.
function identifyIfNeeded(
  socket: WebSocket,
  state: ConnState,
  agentId: string,
  registry: AgentRegistry,
): void {
  if (state.agentId === agentId) return;
  if (state.agentId && state.agentId !== agentId) {
    log.warn(
      { previous: state.agentId, new: agentId },
      "ws: agent_id changed mid-connection, re-registering under new id",
    );
    registry.unregister(state.orgId, state.agentId, socket);
  }
  state.agentId = agentId;
  registry.register(state.orgId, agentId, socket, state.remoteIp);
  log.info({ orgId: state.orgId, agentId, remoteIp: state.remoteIp }, "ws: agent identified");
}

// WebSocket connections here are direct TCP, not behind a reverse proxy (see
// this file's own TLS-termination comment), so req.socket.remoteAddress is
// the real peer address — no X-Forwarded-For handling needed. Node reports
// an IPv4 peer as an IPv6-mapped address ("::ffff:192.168.10.171") on a
// dual-stack socket; stripped here so both the private-IP check in
// geolocation/ipGeo.ts and the plain display value work with the address a
// human actually expects to see.
function normalizeIp(addr: string | undefined): string | null {
  if (!addr) return null;
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}
