// Package version holds the agent's own build version — a plain string
// bumped by hand each time a new build is shipped (this project has no CI
// pipeline that stamps this automatically). The central server compares
// this against downloads/agent-version.txt (see server/src/index.ts's
// loadLatestAgentBuild) to decide whether a connected agent needs to
// self-update — see internal/selfupdate.
package version

// Version must be bumped every time a new agent build is placed in the
// server's downloads/ folder — otherwise already-updated agents and
// not-yet-updated ones both report the same string and the server can't
// tell them apart.
const Version = "2026.08.05-11"
