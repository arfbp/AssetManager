const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest14", password: "TempPass9x2Kq" }),
});
const { token } = await loginRes.json();

const url = "https://ninite.com/klitecodecs/ninite.exe";
const script = [
  '$ErrorActionPreference = "Stop"',
  'Write-Output "STATUS:downloading"',
  '$dest = Join-Path $env:TEMP "ninite-deploy-$(Get-Random).exe"',
  `$req = [System.Net.HttpWebRequest]::Create("${url}")`,
  '$resp = $req.GetResponse()',
  '$respStream = $resp.GetResponseStream()',
  '$fileStream = [System.IO.File]::Create($dest)',
  '$buffer = New-Object byte[] 65536',
  'while (($read = $respStream.Read($buffer, 0, $buffer.Length)) -gt 0) { $fileStream.Write($buffer, 0, $read) }',
  '$fileStream.Close(); $respStream.Close(); $resp.Close()',
  'Write-Output "STATUS:installing"',
  '$proc = Start-Process -FilePath $dest -NoNewWindow -Wait -PassThru',
  'if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "installer exited with code $($proc.ExitCode)" }',
  'Remove-Item $dest -Force -ErrorAction SilentlyContinue',
  'Write-Output "STATUS:done"',
].join("\n");

const res = await fetch(`${BASE}/api/agents/DESKTOP-1NH0P21/run-script`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ script }),
});
const body = await res.json();
console.log("dispatch result:", JSON.stringify(body));
