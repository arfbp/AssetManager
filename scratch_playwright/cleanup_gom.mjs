const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest12", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

// The flag-testing run left GOM Player in a broken half-uninstalled state:
// its own Uninstall.exe deleted itself partway through (likely from the
// /silent attempt) without finishing the rest of its own cleanup, so the
// registry entry, install folder, and shortcut were all still there but
// pointing at a now-missing uninstaller — worse than either the original
// installed state or a real uninstall. Finishing that cleanup by hand
// (remove the stale registry entry, the leftover folder, the shortcut)
// restores a clean, fully-uninstalled end state instead of leaving it
// stuck in the middle.
const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output "STATUS:cleaning"',
  '$paths = @(',
  '    "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
  '    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
  ')',
  '$entries = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "GOM Player" }',
  'foreach ($e in $entries) { Write-Output "REMOVING_REGKEY:$($e.PSPath)"; Remove-Item -LiteralPath $e.PSPath -Recurse -Force -ErrorAction SilentlyContinue }',
  '$dir = "C:\\Program Files (x86)\\GRETECH\\GomPlayer"',
  'if (Test-Path -LiteralPath $dir) { Write-Output "REMOVING_DIR:$dir"; Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }',
  '$gretech = "C:\\Program Files (x86)\\GRETECH"',
  'if ((Test-Path -LiteralPath $gretech) -and ((Get-ChildItem -LiteralPath $gretech -ErrorAction SilentlyContinue).Count -eq 0)) { Remove-Item -LiteralPath $gretech -Force -ErrorAction SilentlyContinue }',
  '$shortcut = "C:\\Users\\Public\\Desktop\\GOM Player.lnk"',
  'if (Test-Path -LiteralPath $shortcut) { Write-Output "REMOVING_SHORTCUT:$shortcut"; Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }',
  '$stillReg = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "GOM Player" }',
  'Write-Output "REGISTRY_STILL_THERE:$([bool]$stillReg)"',
  'Write-Output "DIR_STILL_THERE:$(Test-Path -LiteralPath $dir)"',
  'Write-Output "SHORTCUT_STILL_THERE:$(Test-Path -LiteralPath $shortcut)"',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
