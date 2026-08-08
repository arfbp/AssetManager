# Installs the OptiFleet AI Agent as a Windows Service on THIS machine,
# pointed at the central server's public VPS IP (27.254.142.51) - works from
# any internet connection, anywhere in the world, not just the office LAN.
# Run from an elevated (Administrator) PowerShell prompt.
#
# Uses NSSM (bundled nssm.exe) to register the service, rather than the
# agent binary installing itself. A binary that self-elevates and installs
# its own Windows Service is exactly the behavior pattern antivirus
# heuristics flag as a dropper/trojan - on real target machines that got the
# exe silently deleted moments after it ran, with zero visible error. NSSM
# is a long-established, widely-used service-wrapper tool; having IT do the
# service registration instead of the agent binary itself is a meaningfully
# different, much less suspicious pattern - the same one already running
# this project's own dev-machine agent without issue. The agent exe is also
# self-signed (see README.txt) so it isn't flagged as entirely unsigned,
# though that's not the same as a trusted CA certificate.
#
# The service is installed under its normal name and is visible in
# services.msc / Task Manager - nothing here hides it.
#
# Wrapped in try/catch/finally with a pause at the very end - this file is
# sometimes run directly (e.g. right-click > Run with PowerShell) rather
# than via RUN-ME.bat, and PowerShell closes the window immediately when a
# script like this one exits, error or not. Without the pause, any error
# message - the thing you'd actually need to read - flashes red for a
# fraction of a second and the window is just gone.

$ErrorActionPreference = "Stop"

try {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run as Administrator."
    }

    $serviceName = "OptiFleetAIAgent"
    $installDir = "C:\ProgramData\OptiFleetAgent"
    $scriptDir = $PSScriptRoot

    # Unsigned-binary AV heuristics again - excluding the install path before
    # anything is copied/run stops Defender quarantining it mid-install. Only
    # affects Windows Defender specifically; a centrally-managed corporate AV
    # product needs its own allowlist entry from your IT/security team - no
    # script can add that from here.
    try {
        Add-MpPreference -ExclusionPath $installDir -ErrorAction Stop
        Write-Host "Added Windows Defender exclusion for $installDir"
    } catch {
        Write-Warning "Could not add a Defender exclusion (Defender may be managed centrally by IT policy, or not present) - continuing anyway."
    }

    # Stop and remove any previous install FIRST, before touching any files -
    # a running service holds its own exe file open, so copying a new one
    # over it fails with "cannot access the file, being used by another
    # process" if this happens in the wrong order (verified on a real
    # re-install). sc.exe delete rather than nssm.exe here deliberately -
    # this has to work even when it's the very file about to be overwritten
    # that would otherwise need to remove the service that's locking it.
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Existing install found - stopping and removing it first..."
        if ($existing.Status -eq "Running") {
            Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        & sc.exe delete $serviceName | Out-Null
        Start-Sleep -Seconds 1
    }

    Write-Host "Installing to $installDir ..."
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "logs") | Out-Null
    Copy-Item -Path (Join-Path $scriptDir "optifleet-agent.exe") -Destination $installDir -Force
    Copy-Item -Path (Join-Path $scriptDir "agent.yaml") -Destination $installDir -Force
    Copy-Item -Path (Join-Path $scriptDir "optifleet-cert.pem") -Destination $installDir -Force
    Copy-Item -Path (Join-Path $scriptDir "nssm.exe") -Destination $installDir -Force

    $exePath = Join-Path $installDir "optifleet-agent.exe"
    $configPath = Join-Path $installDir "agent.yaml"
    $nssmPath = Join-Path $installDir "nssm.exe"
    $logDir = Join-Path $installDir "logs"

    Write-Host "Installing service via NSSM (visible in services.msc as '$serviceName')..."
    & $nssmPath install $serviceName $exePath
    # No quotes needed around $configPath: install dir is deliberately under
    # C:\ProgramData (no spaces), not C:\Program Files - NSSM's own
    # "set AppParameters" was verified to strip embedded quote characters
    # when reconstructing this value, which would have silently truncated a
    # spaced path at the first space (e.g. "-config C:\Program" and a
    # dangling, ignored "Files\..." token) with no visible error anywhere.
    & $nssmPath set $serviceName AppParameters "-run -config $configPath"
    & $nssmPath set $serviceName AppDirectory $installDir
    & $nssmPath set $serviceName DisplayName "OptiFleet AI Agent"
    & $nssmPath set $serviceName Description "OptiFleet AI fleet telemetry & management agent"
    & $nssmPath set $serviceName Start SERVICE_AUTO_START
    & $nssmPath set $serviceName AppStdout (Join-Path $logDir "service-stdout.log")
    & $nssmPath set $serviceName AppStderr (Join-Path $logDir "service-stderr.log")

    # This organization's own generated credentials - must match this same
    # org's row in the central server's `organizations` table
    # (agent_auth_token / agent_hmac_secret). Not shared with any other
    # organization on this deployment - treat this file as sensitive.
    # NSSM's own AppEnvironmentExtra is what the running service process
    # actually sees - not the same reliability trap as the earlier
    # self-install path had with kardianos/service's env handling.
    Write-Host "Setting secrets..."
    $envBlock = "__ENV_BLOCK__"
    & $nssmPath set $serviceName AppEnvironmentExtra $envBlock

    Write-Host "Starting service..."
    & $nssmPath start $serviceName
    Start-Sleep -Seconds 3

    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
        Write-Host ""
        Write-Host "Done. Service is running." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Warning "Service did not stay running. Check $logDir\agent.log and $logDir\service-stderr.log"
        Write-Warning "for the actual error, or try: Restart-Service $serviceName"
    }
    Write-Host "Logs: $logDir\agent.log (app) / $logDir\service-stderr.log (crash output, if any)"
} catch {
    Write-Host ""
    Write-Host "INSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Host ""
    Read-Host "Press Enter to close this window"
}
