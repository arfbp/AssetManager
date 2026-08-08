package main

import _ "embed"

// Bundled so the Windows single-file distribution needs no side-by-side
// agent.yaml/cert files — see selfinstall_windows.go. Values here are the
// same LAN test deployment already shipped in dist-agent-deploy/: this dev
// machine's server address, its self-signed LAN cert, and the LAN test
// auth token/HMAC secret (already visible in plaintext in that deployment's
// agent.yaml/install.ps1 — embedding them here doesn't change that
// exposure, only consolidates the files). Rotate all three and rebuild
// before using this outside a trusted local network.

//go:embed embedded/agent.yaml
var embeddedAgentYAML []byte

//go:embed embedded/optifleet-cert.pem
var embeddedCert []byte

const embeddedAuthToken = "test-token"
const embeddedHMACSecret = "test-secret"
