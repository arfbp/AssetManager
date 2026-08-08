const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest12", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

// Tries a handful of common silent-uninstall conventions against GOM
// Player's own Uninstall.exe, checking the real registry state after each
// attempt rather than trusting exit codes (which we've now proven GOM's
// uninstaller reports as 0/success even when it does nothing under a
// SYSTEM/no-desktop session). Stops at the first flag that actually removes
// the registry entry, so this never runs more attempts than necessary.
const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$exe = "C:\\Program Files (x86)\\GRETECH\\GomPlayer\\Uninstall.exe"',
  'function StillInstalled {',
  '    $e = Get-ItemProperty -Path @("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*") -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "GOM Player" }',
  '    return [bool]$e',
  '}',
  '$candidates = @("/S", "/s", "/silent", "/VERYSILENT", "/Q", "/quiet", "-y")',
  '$found = $null',
  'foreach ($flag in $candidates) {',
  '    if (-not (StillInstalled)) { break }',
  '    Write-Output "TRYING:$flag"',
  '    try {',
  '        $p = Start-Process -FilePath $exe -ArgumentList $flag -NoNewWindow -PassThru',
  '        $p.Handle | Out-Null',
  '        $p.WaitForExit(20000) | Out-Null',
  '        if (-not $p.HasExited) { Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID", $p.Id, "/T", "/F" -NoNewWindow -Wait -ErrorAction SilentlyContinue }',
  '        Write-Output "EXITCODE:$flag=$($p.ExitCode)"',
  '    } catch {',
  '        Write-Output "THREW:$flag=$($_.Exception.Message)"',
  '    }',
  '    Start-Sleep -Seconds 2',
  '    if (-not (StillInstalled)) { $found = $flag; Write-Output "WORKED:$flag" }',
  '}',
  'if (-not $found -and (StillInstalled)) { Write-Output "NONE_WORKED" }',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
