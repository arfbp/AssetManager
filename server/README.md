# OptiFleet Central Server

Backend for the OptiFleet AI fleet: a WebSocket hub for the Go agents, an
HTTP API for the dashboard, an LLM-based natural-language command parser
(Claude API), and the security guardrail that decides what — if anything —
actually gets sent to a device.

## Why Claude API, not OpenAI

This project already runs inside a Claude Code / Anthropic tooling context,
so the LLM integration here targets the Claude API directly via the official
`@anthropic-ai/sdk` (tool use with a forced, strict-schema tool call — see
`src/llm/actionParser.ts`). If you need OpenAI instead, swap
`src/llm/actionParser.ts` for the OpenAI SDK's function-calling equivalent —
the rest of the pipeline (schema, guardrail, dispatch) is provider-agnostic
and doesn't need to change.

## The most important design decision here: the LLM never authors executable content

`src/llm/actionParser.ts` uses Claude's tool use with `tool_choice` forcing a
single tool call and `strict: true` on the schema (`src/llm/schema.ts`). The
model can only ever return five fixed fields — `action` (a closed enum),
`target`, `scope`, `confirm`, `reasoning` — never free text, never a
command the agent doesn't implement, and never a script body.

That's deliberate, and it's why `uninstall_software` works the way it does:
the model extracts *which app* the operator named, but the actual removal
command comes from a small, human-reviewed table
(`src/llm/uninstallTemplates.ts`) keyed by app name. If an app isn't in that
table, the request is rejected — the model never gets to improvise an
uninstall script. The same principle blocks `run_script` from ever being
dispatched via the natural-language path at all (see
`src/security/guardrail.ts`): a script's content has no bounded shape the
way `kill_process`'s PID/name does, so it can't be safely inferred from free
text no matter how good the parser is. A real "run this script" flow needs a
human to write and submit the script explicitly — that's a different
endpoint this repo intentionally doesn't build yet.

The parser's output is **never treated as an authorization decision** — see
the trust-boundary comment at the top of `actionParser.ts`. Everything that
matters (scope resolution, allowlist membership, blacklist scan,
confirmation requirements) is re-derived independently in
`src/security/guardrail.ts`, which is the only thing standing between "the
model said so" and a signed command reaching a device.

## Request pipeline (`POST /api/command`)

```
dashboard text
  -> parseNaturalLanguageCommand()   Claude tool use, forced call, strict schema
  -> evaluateParsedIntent()          guardrail: scope resolution, blacklist, confirmation gate
  -> blocked:              422, nothing dispatched
  -> needs_confirmation:   202 + pendingId, operator must POST /api/command/:id/confirm within 5 min
  -> allowed:               dispatch immediately, signed + sent to every resolved target
```

**When confirmation is required** (`src/security/guardrail.ts`):
- `restart_host` / `uninstall_software`: always, unless the request text itself
  explicitly confirmed *and* it targets exactly one device — any multi-device
  destructive action gets a human review step regardless of phrasing.
- `kill_process`: only when the resolved scope is 3+ devices (a mass action).
- `clean_temp`: never — already bounded by the agent's own directory allowlist.
- `run_script`: never reachable from this path at all (see above).

## Wire compatibility with the Go agent

`src/protocol.ts` mirrors `internal/transport/protocol.go` on the agent by
hand — there's no shared schema generator, so a field added on one side
needs the same edit on the other.

**Command signing** (`src/crypto/commandSigner.ts`) uses a netstring-encoded
canonical form (`"<byte-length>:<bytes>"`, Bencode-style), not JSON. A
JSON-based canonical signing scheme would need to reproduce Go's
`json.Marshal` byte-for-byte — including its default HTML-escaping of `<`,
`>`, `&` — to get identical signatures across languages, which is a real
footgun for exactly the kind of content a script parameter can contain.
Netstrings need no escaping at all: every field declares its own byte
length, so concatenation is unambiguous regardless of content. Both sides
were updated together — see `internal/transport/protocol.go`'s
`CanonicalString()` on the agent.

**Agent identification**: there's no separate handshake message — an
agent's first `heartbeat` or `telemetry` message carries `agent_id`
(its hostname), and `src/ws/server.ts` registers the connection under that ID
at that point, matching how the Go agent's `transport.Client` is written.

**kill_process by name**: natural-language requests name a process
("the antivirus scanner"), not a PID. The agent's `kill_process` action
(`internal/executor/executor.go`) was extended to accept either `params.pid`
or `params.name` — a name resolves against the agent's live process list at
execution time and refuses if it matches more than one running process
(returns the PIDs so a human can disambiguate) rather than silently killing
every match.

## Running

```powershell
cd server
npm install
cp .env.example .env    # then edit — see below
cp config/device-groups.example.json config/device-groups.json   # then edit
npm run dev              # tsx watch, for local development
# or: npm run build && npm start
```

Node.js and npm were not available in the environment this was written in —
install Node 20+ before running the commands above, and run `npm run
typecheck` once dependencies are installed to catch anything version drift
in `@anthropic-ai/sdk` might have introduced (the SDK's exact type surface
for newer features like `output_config`/`strict`/`stop_details` can shift
between versions — a few spots in `src/llm/` deliberately use local
structural types instead of importing the SDK's own type names for exactly
this reason, so a mismatch fails as a clear runtime/type error rather than
a mysterious import failure).

Required environment variables — see `.env.example` for the full list and
comments:

- `OPTIFLEET_AGENT_AUTH_TOKEN` — bearer token agents authenticate with. Must
  match `OPTIFLEET_AUTH_TOKEN` on every agent (`configs/agent.yaml` /
  `internal/config`).
- `OPTIFLEET_HMAC_SECRET` — must exactly match the agent's
  `OPTIFLEET_HMAC_SECRET`.
- `ANTHROPIC_API_KEY` — or leave unset and use `ant auth login` / Workload
  Identity Federation; the SDK's standard credential resolution applies.
- `OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH` — independent server-side copy of
  the agent's own run_script gate. Both must be true for `uninstall_software`
  (the only path that reaches run_script) to work at all.

In production, set `NODE_ENV=production` and `OPTIFLEET_TLS_CERT_PATH` /
`OPTIFLEET_TLS_KEY_PATH` — `src/config.ts` refuses to start otherwise rather
than silently serving agents over plaintext `ws://`.

## Dashboard-facing additions (for `frontend/`)

Added to support the Next.js dashboard:

- **`GET /ws/dashboard`** (`src/ws/dashboardServer.ts`) — a second WebSocket
  endpoint, separate from the agent hub, that pushes live `agent_update` and
  `history_entry` messages to connected browser tabs (plus a full `snapshot`
  on connect). Auth is a `?token=` query param (browsers can't set custom
  headers on a native `WebSocket`), validated against a real per-user session
  in Postgres (`src/auth/sessions.ts`) — a different token namespace from
  the agent hub's, on purpose.
- **`AgentRegistry`** now keeps agents after disconnect instead of deleting
  them — they flip to `status: "offline"` and keep their last-known
  telemetry, so the dashboard can show an unreachable device instead of it
  vanishing. It extends `EventEmitter` and emits `"update"` on every state
  change, which is what `dashboardServer.ts` subscribes to.
- **`CommandHistoryStore`** (`src/history/commandHistory.ts`) — a bounded
  in-memory log (500 entries) of every dispatched command and its eventual
  `command_result`, correlated by command ID. `GET /api/command-history`
  reads it; `dispatchToTargets` writes to it on every call.
- **`POST /api/agents/:id/kill-process`** — direct process control for the
  Task Manager UI's "Force Close" button. Skips the LLM parser (the UI
  already knows exactly what it wants) but still goes through the same
  signed-dispatch path as everything else, so it's audited and
  history-logged identically to a chat-originated command.
- **`POST /api/agents/:id/suggest-remediation`**
  (`src/llm/remediationAdvisor.ts`) — a second, smaller Claude tool-use call
  that looks at one process's live CPU/RAM from the last telemetry snapshot
  and returns a `{suggested_action, reasoning, risk_note}` recommendation.
  **It never applies anything itself** — the frontend shows the suggestion
  and the operator clicks through to `kill-process` above if they agree.
  This is the "One-Click Auto Remediation" button's backend: one click to
  get the AI's opinion, one more to act on it — never a single click that
  both asks and kills.
- **Real per-user login** (`src/auth/`): `POST /api/auth/login` verifies a
  username/password (bcrypt-hashed in the `users` table) and issues an opaque
  session token stored in the `sessions` table — not a JWT, so revocation is
  a plain `DELETE` rather than waiting out a signature's own expiry. Every
  other `/api/*` route requires `Authorization: Bearer <session token>`,
  validated against that table on each request (router-level middleware in
  `src/api/routes.ts`). There's no public registration endpoint — accounts
  are created by an administrator via `npm run user:create -- <username>
  <password>`. `requestedBy` on every dispatched command is derived from the
  authenticated session server-side, not taken from the request body, so a
  client can't claim to be a different user than the one it logged in as.
- **CORS** (`src/index.ts`, `cors` package): the dashboard runs on a
  different origin (`localhost:3000`) than this server (`localhost:8080`),
  and every REST call it makes carries a custom `Authorization` header —
  that makes it a CORS-preflighted request regardless of method, which the
  browser blocks client-side unless the server sends back
  `Access-Control-Allow-Origin`. Set `OPTIFLEET_DASHBOARD_ORIGIN` to
  whatever origin(s) actually serve the dashboard (comma-separated for
  more than one) — it must match the browser's address bar exactly
  (scheme + host + port, no trailing slash). **This only matters to an
  actual browser** — `curl`, Node's `fetch`, Playwright-less scripts, and
  PowerShell's `Invoke-RestMethod` don't enforce CORS at all, so a gap here
  is invisible to any test that doesn't run in a real browser context.

## Persistence (Postgres)

Required — user accounts and sessions (`src/auth/`) live in Postgres, not
memory, so login has nowhere to persist without it; telemetry/command
history durability rides along on the same connection. Set up:

```powershell
cp .env.example .env   # then set OPTIFLEET_DATABASE_URL
npm run db:migrate      # applies src/db/schema.sql (idempotent, safe to re-run)
npm run user:create -- <username> <password>   # create your first login
```

`src/db/persistence.ts` (`wirePersistence`, called once in `src/index.ts`)
subscribes to the same `"update"`/`"telemetry"` events on `AgentRegistry` and
`"entry"` events on `CommandHistoryStore` that `ws/dashboardServer.ts`
already uses to push live updates to the browser — so nothing in
`ws/server.ts`, `api/routes.ts`, or `ws/dispatch.ts` needed to change to add
durable storage. Three tables: `agents` (current state, upserted),
`telemetry_snapshots` (append-only time series, one row per snapshot — this
is what makes historical charts possible instead of only "last known"),
`command_history` (mirrors the in-memory ring buffer, but unbounded and
durable). All writes are fire-and-forget with errors caught and logged —
a Postgres outage degrades to "this snapshot didn't get persisted", it
never blocks or breaks live agent handling or command dispatch.

This single-process design is the right starting point before a multi-region
deployment; see "Scaling beyond one instance" below for what changes once
agents are online across regions and a lone Postgres write path becomes the
next bottleneck (that's a queue in front of the DB writes, not a rethink of
this schema).

## Scaling beyond one instance

`src/ws/registry.ts` is an in-memory `Map` — correct for a single server
process, but a second process has no visibility into the first one's
connected agents. Horizontal scaling needs a shared registry (Redis pub/sub
is the usual choice: publish connect/disconnect/telemetry events, and route
outbound commands through a channel the process holding that agent's socket
subscribes to). The `AgentRegistry` class is deliberately the only thing
`src/ws/server.ts` and `src/ws/dispatch.ts` talk to, so that swap is
contained to one file.

## Stability under many concurrent agents

- `src/ws/server.ts` runs a ping/pong sweep every 30s and terminates any
  connection that didn't respond since the last sweep — this is what
  actually prunes half-dead sockets from network blips over hours/days,
  rather than accumulating them.
- A single malformed or hostile message from one agent is caught per-message
  (`socket.on("message", ...)` wraps the handler in try/catch) so it can't
  take the whole hub down for every other connected agent.
- `src/index.ts` installs `uncaughtException` / `unhandledRejection`
  handlers that log with full context and exit — run this under a process
  supervisor (systemd, pm2, a container restart policy) so a truly
  unexpected failure restarts into a clean state instead of limping along.

## What's intentionally not implemented yet

- A real `run_script` submission flow (explicit script body + human review),
  as discussed above.
- Structured audit-log storage — `audit` currently logs to stdout via pino
  (separately from the new Postgres `command_history` table above, which
  only records dispatch outcomes, not the full audit trail); wire pino's
  output into your log pipeline the same way as the agent's `audit.log`.
- Dashboard authentication/authorization for `POST /api/command` itself —
  `requestedBy` is currently a free-text field the caller supplies, not a
  verified identity. Put this behind your existing auth layer (SSO, API
  gateway) before exposing it beyond a trusted internal network.
