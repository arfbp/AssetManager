# OptiFleet AI Dashboard

Next.js (App Router) + Tailwind CSS frontend for IT support and leadership:
real-time endpoint monitoring, an AI natural-language command console, and a
per-device task/process manager. Talks to `../server` (the Central Server) —
nothing in this app calls an LLM or an agent directly.

## Running

```powershell
cd frontend
npm install
cp .env.local.example .env.local   # then edit — must match server/.env
npm run dev
```

Node.js and npm were not available in the environment this was written in —
install Node 20+ and run `npm run typecheck` once dependencies are installed.
`next-env.d.ts` is generated automatically the first time you run `npm run
dev` or `npm run build`; it's normal for it to be absent before that.

The two `NEXT_PUBLIC_*` URLs in `.env.local` must point at wherever
`server/` is actually listening (`OPTIFLEET_HTTP_PORT`) — see
`.env.local.example`'s comments. There's no token to match anymore: the
dashboard logs in against the server's real accounts (`src/lib/session.ts`,
`server/src/auth/`) instead of a shared secret baked into the build.

## Where each requirement lives

1. **Real-time endpoint monitoring** — `src/components/endpoints/` (`EndpointGrid` + `EndpointCard`), fed by `src/hooks/useDashboardSocket.ts`. This opens one WebSocket to the server's `/ws/dashboard` endpoint and receives push updates (`agent_update`, `history_entry`) — there is no polling loop anywhere in this app. CPU/RAM/Disk render as `Meter` components (`src/components/meters/Meter.tsx`); Online/Offline as `StatusBadge`.
2. **AI chat command console + history log** — `src/components/chat/ChatConsole.tsx` (natural-language input, calls `POST /api/command`, renders the server's dispatched/needs-confirmation/blocked outcome) and `src/components/history/CommandHistoryPanel.tsx` (every dispatched command — chat-originated or button-originated — with a live success/fail status, also pushed over the same WebSocket).
3. **Task & process manager** — `src/components/process/ProcessManagerDrawer.tsx`, opened by clicking any endpoint card. Two tabs: **Live** lists the device's processes from its last telemetry snapshot (with a **Force Close** button per process and an **AI suggestion** button for one-click auto remediation) plus a **Connected devices** panel (USB/printers/monitors currently attached, grouped by type — internal/telemetry/devices_*.go on the agent side); **History** is the CPU/RAM/Disk trend chart, `src/components/history/HistoryChart.tsx`.

## Design decisions worth knowing

**Colors come from the dataviz skill's validated reference palette**, not
picked by eye — see `src/app/globals.css` for the token definitions and
`tailwind.config.ts` for how they're exposed to Tailwind classes
(`bg-status-critical`, `text-ink-secondary`, etc.). Status colors
(good/warning/serious→unused here/critical) are the palette's fixed status
role, reserved for state and never reused for anything else. Every status
indicator pairs a color with an icon-equivalent (a dot) *and* a text label —
color is never the only signal, both for accessibility and because a
red-only "something's wrong" dot doesn't tell an admin what's actually
wrong.

**Meter thresholds match the Go agent's own alert trigger.** `src/lib/format.ts`'s
`severityForPercent()` flips to "critical" at 85% — the exact CPU/RAM
threshold that makes `internal/telemetry/poller.go` on the agent itself
switch to its 10-second alert-mode polling. The dashboard's red state and
the agent's own "something's wrong, look closer" state are the same number,
not two independently-chosen thresholds that could drift apart.

**"One-click AI auto remediation" is deliberately two clicks, not one.**
The AI suggestion button (`POST /api/agents/:id/suggest-remediation`) only
ever returns a recommendation — reasoning and a risk note, never an action
taken. Applying it is a separate, explicit "Apply: force close" button that
goes through the exact same path as manually clicking "Force close" on any
other process. A single button that both asks the AI and kills the process
in one click would mean one bad or hallucinated suggestion executes with no
human in between — see the same reasoning applied server-side in
`server/README.md`'s notes on the guardrail and confirmation flow. The
"Force close" button itself still has a native `confirm()` prompt before it
sends anything, since force-closing a process can lose unsaved work
regardless of whether a human or the AI picked the target.

**Theme is a selection, not just a media-query flip.** `src/components/theme/ThemeToggle.tsx`
cycles light → dark → follow-system, persisted to `localStorage`; the inline
script in `src/app/layout.tsx`'s `<head>` applies the stored choice before
first paint so there's no flash of the wrong theme.

## What's intentionally not implemented yet

- **SSO/OAuth login.** Accounts are username+password only (`src/components/auth/`,
  `server/src/auth/`), admin-created via `npm run user:create` — no external
  identity provider integration. `requestedBy` on every dispatched command is
  the authenticated username, not client-supplied, so this is a real
  verified identity; there's just no SSO in front of it yet.
- **A `run_script` submission UI.** The server's guardrail refuses to
  dispatch `run_script` from the natural-language path at all (see
  `server/src/security/guardrail.ts`), so there's nothing for this frontend
  to expose yet — a future "submit a reviewed script" flow would need its
  own explicit, human-authored form, not a chat message.
- **Historical telemetry / trend charts.** The endpoint cards and process
  drawer show only the latest snapshot — there's no time-series storage on
  the server yet to chart against. Adding one is a server-side change
  first (see `server/README.md`'s "What's intentionally not implemented
  yet"), then a chart here, per the dataviz skill's guidance, once there's
  real time-series data to plot.
