const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest16", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

// TeamViewer's own docs document "/S" as the silent switch for both its
// installer and uninstall.exe — user confirmed this machine doesn't rely on
// it for remote access, so this is safe to actually test for real (not just
// probe) rather than trial-and-error through a long candidate list like the
// GOM Player case, where no such documented convention existed.
const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output "STATUS:uninstalling"',
  '$exe = "C:\\Program Files\\TeamViewer\\uninstall.exe"',
  '$proc = Start-Process -FilePath $exe -ArgumentList "/S" -NoNewWindow -PassThru',
  '$proc.Handle | Out-Null',
  '$exited = $proc.WaitForExit(30000)',
  'Write-Output "EXITED_IN_TIME:$exited"',
  'if ($exited) { Write-Output "EXITCODE:$($proc.ExitCode)" }',
  'Start-Sleep -Seconds 3',
  '$paths = @("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")',
  '$stillThere = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "TeamViewer" }',
  'Write-Output "STILL_INSTALLED:$([bool]$stillThere)"',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
