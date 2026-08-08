const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest11", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output "STATUS:checking"',
  '$procs = Get-Process | Where-Object { $_.Path -like "*GomPlayer*" -or $_.ProcessName -like "*ninst*" -or $_.ProcessName -like "*GOM*" }',
  'foreach ($p in $procs) { Write-Output "PROC:$($p.ProcessName)|$($p.Id)|$($p.Path)|StartTime=$($p.StartTime)" }',
  'Write-Output "PROC_COUNT:$($procs.Count)"',
  '$tmpUninst = Get-ChildItem -Path $env:TEMP -Recurse -Filter "*ninst*" -ErrorAction SilentlyContinue',
  'foreach ($t in $tmpUninst) { Write-Output "TEMPFILE:$($t.FullName)" }',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
