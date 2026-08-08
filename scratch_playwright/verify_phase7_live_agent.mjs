import WebSocket from "ws";
import https from "node:https";

const BASE = "https://27-254-142-51.sslip.io";
const agent = new https.Agent({ rejectUnauthorized: false });

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "legacy" },
  body: JSON.stringify({ username: "_swtest20", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

const createRes = await fetch(`${BASE}/api/orgs`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    name: "Live Agent Test Org",
    subdomain: "live-agent-test",
    adminUsername: "liveadmin",
    adminPassword: "LiveTestPass9x2",
    adminFirstName: "Live",
    adminLastName: "Test",
  }),
});
const created = await createRes.json();
console.log("org created:", created.org.id, created.org.subdomain);

// No server restart here — this is the whole point of the test: does the
// freshly generated agent_auth_token work IMMEDIATELY against the live
// agent-hub WebSocket (wss://<host>:8443), proving orgCredentials.reload()
// after creation actually took effect.
const ws = new WebSocket("wss://27.254.142.51:8443/", {
  headers: { Authorization: `Bearer ${created.agentAuthToken}` },
  agent,
});
ws.on("open", () => {
  console.log("NEW ORG'S AGENT CREDENTIALS WORK IMMEDIATELY — connection accepted with zero server restart");
  ws.close();
  process.exit(0);
});
ws.on("unexpected-response", (req, res) => {
  console.log("REJECTED, status:", res.statusCode);
  process.exit(1);
});
ws.on("error", (err) => {
  console.log("ERROR:", err.message);
  process.exit(1);
});
