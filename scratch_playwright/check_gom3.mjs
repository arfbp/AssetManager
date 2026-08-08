const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest12", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

const script = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output "STATUS:checking"',
  '$paths = @(',
  '    "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
  '    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
  ')',
  '$gom = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*GOM*" }',
  'Write-Output "REGISTRY_ENTRY_EXISTS:$([bool]$gom)"',
  '$exeExists = Test-Path -LiteralPath "C:\\Program Files (x86)\\GRETECH\\GomPlayer\\Uninstall.exe"',
  'Write-Output "UNINSTALLEXE_EXISTS:$exeExists"',
  '$dirExists = Test-Path -LiteralPath "C:\\Program Files (x86)\\GRETECH\\GomPlayer"',
  'Write-Output "INSTALL_DIR_EXISTS:$dirExists"',
  'if ($dirExists) { Get-ChildItem -LiteralPath "C:\\Program Files (x86)\\GRETECH\\GomPlayer" -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "REMAININGFILE:$($_.Name)" } }',
  '$shortcut = Test-Path -LiteralPath "C:\\Users\\Public\\Desktop\\GOM Player.lnk"',
  'Write-Output "SHORTCUT_EXISTS:$shortcut"',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
