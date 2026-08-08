import { readFileSync } from "node:fs";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest4", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();
const fileBuf = readFileSync("C:/Users/PC/AppData/Local/Temp/optifleet-agent-v11.exe");
const uploadRes = await fetch(`${BASE}/api/agent-builds?version=${encodeURIComponent("2026.08.05-11")}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
  body: fileBuf,
});
console.log("upload status:", uploadRes.status, await uploadRes.text());
const activateRes = await fetch(`${BASE}/api/agent-builds/${encodeURIComponent("2026.08.05-11")}/activate`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
console.log("activate status:", activateRes.status, await activateRes.text());
