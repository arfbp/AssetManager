# Build และติดตั้ง OptiFleet AI Agent เป็น Windows Service มาตรฐาน
# ต้องรันจาก PowerShell prompt แบบ elevated (Administrator)
#
# service จะถูกติดตั้งภายใต้ display name ปกติและมองเห็นได้ใน services.msc
# และ Task Manager > Services — สคริปต์นี้ไม่ได้พยายามซ่อนมัน ถ้าต้องการ
# กระจายในสเกลใหญ่ ให้ใช้เครื่องมือ deploy ซอฟต์แวร์ที่มีอยู่แล้ว (Intune,
# SCCM, GPO) แทนที่จะรันสคริปต์นี้แบบ interactive ทีละเครื่อง

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repoRoot "bin"
$exePath = Join-Path $binDir "optifleet-agent.exe"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

Write-Host "Building agent..."
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Push-Location $repoRoot
try {
    $env:CGO_ENABLED = "0"
    go build -ldflags "-s -w" -o $exePath ./cmd/agent
} finally {
    Pop-Location
}

if (-not (Test-Path $exePath)) {
    Write-Error "Build failed: $exePath was not produced."
    exit 1
}

$configPath = Join-Path $repoRoot "configs\agent.yaml"

Write-Host "Installing service (visible in services.msc as 'OptiFleet AI Agent')..."
& $exePath -service install -config $configPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "Service install failed."
    exit 1
}

Write-Host "Starting service..."
& $exePath -service start -config $configPath

Write-Host ""
Write-Host "Done. Verify with: Get-Service OptiFleetAIAgent"
Write-Host "Secrets: set OPTIFLEET_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET as machine-level"
Write-Host "environment variables (or via your secrets manager) before starting the"
Write-Host "service — do not hardcode them in agent.yaml."
