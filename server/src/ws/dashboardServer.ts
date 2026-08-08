// A second WebSocket endpoint, separate from the agent hub in ws/server.ts,
// for browser dashboard clients. Pushes live agent status and command
// history updates so the frontend doesn't have to poll.
//
// Attached to the same HTTP server Express listens on (see index.ts) rather
// than opening its own port — one fewer port to expose/firewall. For
// production TLS termination, put this behind a reverse proxy (nginx/Caddy)
// the way most Node deployments do; the agent hub in ws/server.ts handles
// TLS directly instead because it's the one required to run standalone in
// this repo's default setup.
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { validateSession } from "../auth/sessions.js";
import type { AgentRegistry, AgentSummary } from "./registry.js";
import type { CommandHistoryStore, HistoryEntry } from "../history/commandHistory.js";
import type { CommandOutputPayload } from "../protocol.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function startDashboardWsServer(
  cfg: Config,
  httpServer: HttpServer | HttpsServer,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  pool: Pool,
): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws/dashboard",
    verifyClient: (info, cb) => {
      // Browsers cannot set custom headers on a native WebSocket, so the
      // session token can't travel as an Authorization header the way the
      // agent hub's bearer auth does. It previously rode in the URL's query
      // string instead — which nginx's default access-log format records
      // in full, meaning every dashboard session's token was being written
      // to disk in plaintext on every connect. Sec-WebSocket-Protocol is
      // the standard workaround for exactly this browser limitation: the
      // client sets it via `new WebSocket(url, [token])` (see
      // useDashboardSocket.ts), which becomes a request *header*, not part
      // of the URL — nginx/access logs never see it. Still the same real,
      // revocable, per-user session looked up in Postgres
      // (src/auth/sessions.ts) — not a shared static secret, just carried
      // differently.
      const token = (info.req.headers["sec-websocket-protocol"] ?? "").split(",")[0]?.trim() ?? "";
      validateSession(pool, token)
        .then((session) => {
          if (!session) {
            log.warn({ remote: info.req.socket.remoteAddress }, "dashboard ws: rejected connection, bad/expired session");
            cb(false, 401, "unauthorized");
            return;
          }
          // ws's connection handler below receives this exact same `req`
          // object as its second argument — stashing the resolved org here
          // is the standard way to pass data from verifyClient forward,
          // same trick ws/server.ts's agent-hub verifyClient uses for its
          // own per-connection org resolution.
          (info.req as IncomingMessage & { orgId?: string }).orgId = session.orgId;
          cb(true);
        })
        .catch((err) => {
          log.error({ err }, "dashboard ws: session validation failed");
          cb(false, 500, "internal error");
        });
    },
  });

  const alive = new WeakMap<WebSocket, boolean>();
  // Every event broadcast below carries the orgId of the org it's about —
  // this is what makes multi-tenancy real at the one layer most likely to
  // leak it silently: without this, any connected browser tab would see
  // every OTHER org's live agent/telemetry/command updates the instant they
  // happened, regardless of which org's data the REST API correctly
  // filters. socketOrg is set once at connect time (a dashboard session's
  // org never changes mid-connection) and never re-read from anywhere else.
  const socketOrg = new WeakMap<WebSocket, string>();

  wss.on("connection", (socket, req) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    // Always set — verifyClient rejects the upgrade before this handler
    // ever runs if no session (and therefore no org) resolved.
    const orgId = (req as IncomingMessage & { orgId?: string }).orgId!;
    socketOrg.set(socket, orgId);

    // Full snapshot on connect so a freshly-opened dashboard tab isn't
    // empty until the next state change happens to occur — filtered to
    // this socket's own org, same boundary as every REST read.
    send(socket, {
      type: "snapshot",
      agents: registry.listAll().filter((a) => a.orgId === orgId),
      history: history.recent().filter((e) => e.orgId === orgId),
    });

    socket.on("close", () => {
      /* nothing to clean up beyond the WeakMap entries, which GC themselves */
    });
  });

  const onAgentUpdate = (agent: AgentSummary) => broadcast(wss, socketOrg, agent.orgId, { type: "agent_update", agent });
  const onHistoryEntry = (entry: HistoryEntry) => broadcast(wss, socketOrg, entry.orgId, { type: "history_entry", entry });
  const onCommandOutput = (evt: { orgId: string; agentId: string; payload: CommandOutputPayload }) =>
    broadcast(wss, socketOrg, evt.orgId, { type: "command_output", agentId: evt.agentId, output: evt.payload });
  registry.on("update", onAgentUpdate);
  history.on("entry", onHistoryEntry);
  registry.on("command_output", onCommandOutput);

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeatTimer);
    registry.off("update", onAgentUpdate);
    history.off("entry", onHistoryEntry);
    registry.off("command_output", onCommandOutput);
  });

  log.info("dashboard ws: listening at /ws/dashboard");
  return wss;
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

// Only ever reaches sockets whose own session org matches the event's org —
// see socketOrg's doc comment above for why this exists at all.
function broadcast(wss: WebSocketServer, socketOrg: WeakMap<WebSocket, string>, orgId: string, msg: unknown): void {
  const raw = JSON.stringify(msg);
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN && socketOrg.get(socket) === orgId) socket.send(raw);
  }
}
