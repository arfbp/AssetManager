const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest5", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();
const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/kill-process`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ pid: 18144 }),
});
console.log(res.status, await res.text());
