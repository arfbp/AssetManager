const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest15", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output "STATUS:checking"',
  '$paths = @(',
  '    "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
  '    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
  ')',
  '$tv = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*TeamViewer*" }',
  'foreach ($t in $tv) { Write-Output "DISPLAYNAME:$($t.DisplayName)"; Write-Output "UNINSTALLSTRING:$($t.UninstallString)"; Write-Output "QUIETUNINSTALLSTRING:$($t.QuietUninstallString)" }',
  '$procs = Get-Process -Name "TeamViewer*" -ErrorAction SilentlyContinue',
  'foreach ($p in $procs) { Write-Output "PROC:$($p.ProcessName)|$($p.Id)" }',
  '$svc = Get-Service -Name "TeamViewer*" -ErrorAction SilentlyContinue',
  'foreach ($s in $svc) { Write-Output "SERVICE:$($s.Name)|$($s.Status)" }',
  // TeamViewer logs active/recent sessions here — checking this tells us if
  // it's actually in use as a remote-access channel right now before we do
  // anything that might kill it out from under someone.
  '$connLog = "$env:APPDATA\\TeamViewer\\Connections_incoming.txt"',
  'if (Test-Path $connLog) { Write-Output "RECENT_CONNECTIONS:"; Get-Content $connLog -Tail 3 | ForEach-Object { Write-Output "  $_" } }',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
