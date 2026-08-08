# Builds and installs the OptiFleet AI Agent as a standard Windows Service.
# Must be run from an elevated (Administrator) PowerShell prompt.
#
# The service is installed under its normal display name and IS visible in
# services.msc and Task Manager > Services — this script does not attempt to
# hide it. If you need to distribute this at scale, use your existing
# software deployment tooling (Intune, SCCM, GPO) rather than running this
# interactively on each machine.

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
