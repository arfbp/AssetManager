package telemetry

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// This machine's real internet-facing public IP — distinct from
// Snapshot.IPAddresses (this machine's own LAN-side interface addresses)
// and from whatever address the central server's own WebSocket connection
// sees this agent come from. That connection-level address is only the
// real public IP if the server itself lives out on the internet somewhere
// — if the server happens to sit on the same LAN as this agent (the normal
// case for on-prem/LAN test deployments), it only ever sees another
// private address, the same way two people in one room don't need each
// other's home address to talk. There is no way for a machine to learn its
// own internet-facing address except by asking an external service what
// address it sees the request arrive from — same principle a site like
// whatismyip.com uses, just queried from the agent's side instead of a
// browser's.
var (
	publicIPValue atomic.Value // string
	publicIPOnce  sync.Once
)

// Refetched rarely, not on every telemetry poll (every 5m normally, 10s in
// alert mode) — a public IP is effectively static day to day, and hammering
// a free external service on every poll across a whole fleet would be both
// wasteful and a good way to get rate-limited.
const publicIPRefreshInterval = 30 * time.Minute

// collectPublicIP reads whatever's cached (possibly "" for the first second
// or two after agent startup, before the background refresh completes) —
// deliberately never makes the external HTTP call inline on the caller's
// goroutine, since this is invoked from the synchronous telemetry-collection
// path and a slow/hanging external request must never delay a poll cycle,
// especially the 10s alert-mode interval.
func collectPublicIP() string {
	publicIPOnce.Do(func() {
		publicIPValue.Store("")
		go publicIPRefreshLoop()
	})
	v, _ := publicIPValue.Load().(string)
	return v
}

func publicIPRefreshLoop() {
	refreshPublicIPOnce()
	ticker := time.NewTicker(publicIPRefreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		refreshPublicIPOnce()
	}
}

// api.ipify.org: free, no API key, widely used, plain JSON response
// ({"ip":"1.2.3.4"}). A failed lookup just leaves the previous cached value
// (or "" if there's never been a successful one yet) — best-effort, same as
// every other optional telemetry field in this package.
func refreshPublicIPOnce() {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org?format=json")
	if err != nil {
		return
	}
	defer resp.Body.Close()

	var body struct {
		IP string `json:"ip"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.IP == "" {
		return
	}
	publicIPValue.Store(body.IP)
}
