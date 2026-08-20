# ติดตั้ง OptiFleet AI Agent เป็น Windows Service บนเครื่องนี้ ชี้ไปที่
# IP สาธารณะของ VPS ของ central server (27.254.142.51) - ใช้งานได้จาก
# การเชื่อมต่ออินเทอร์เน็ตใดก็ได้ ไม่ใช่แค่ใน LAN ของออฟฟิศ
# รันจาก PowerShell prompt แบบ elevated (Administrator)
#
# ใช้ NSSM (nssm.exe ที่แนบมาด้วย) ลงทะเบียน service แทนที่จะให้ agent
# binary ติดตั้งตัวเอง เพราะ binary ที่ self-elevate แล้วติดตั้ง Windows
# Service ของตัวเองคือพฤติกรรมที่ heuristic ของ antivirus มักตั้งธงว่าเป็น
# dropper/trojan พอดี - บนเครื่องเป้าหมายจริงเคยเจอ exe ถูกลบเงียบๆ ไม่กี่
# วินาทีหลังรัน โดยไม่มี error ให้เห็นเลย NSSM เป็นเครื่องมือ service
# wrapper ที่ใช้กันมานานและแพร่หลาย การให้ IT ลงทะเบียน service แทนที่จะให้
# agent binary ทำเองเป็นแพตเทิร์นที่ต่างออกไปอย่างมีนัยสำคัญและน่าสงสัยน้อย
# กว่ามาก - แบบเดียวกับที่รัน agent บนเครื่อง dev ของโปรเจกต์นี้เองอยู่แล้ว
# โดยไม่มีปัญหา agent exe เองก็ self-signed ด้วย (ดู README.txt) จึงไม่ถูก
# ตั้งธงว่าไม่มีลายเซ็นเลย แม้จะไม่เทียบเท่า certificate จาก CA ที่เชื่อถือได้
#
# service ถูกติดตั้งภายใต้ชื่อปกติและมองเห็นได้ใน services.msc / Task
# Manager - ไม่มีอะไรในนี้ที่ซ่อนมัน
#
# ครอบด้วย try/catch/finally พร้อม pause ตอนจบ - ไฟล์นี้บางครั้งถูกรัน
# ตรงๆ (เช่น right-click > Run with PowerShell) แทนที่จะผ่าน RUN-ME.bat
# และ PowerShell จะปิดหน้าต่างทันทีเมื่อสคริปต์แบบนี้จบ ไม่ว่าจะ error
# หรือไม่ ถ้าไม่มี pause ข้อความ error - สิ่งที่ต้องอ่านจริงๆ - จะกระพริบ
# แดงแค่เสี้ยววินาทีแล้วหน้าต่างก็หายไปเลย

$ErrorActionPreference = "Stop"

try {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run as Administrator."
    }

    $serviceName = "OptiFleetAIAgent"
    $installDir = "C:\ProgramData\OptiFleetAgent"
    $scriptDir = $PSScriptRoot

    # เรื่อง heuristic ของ AV กับ binary ที่ไม่มีลายเซ็นอีกครั้ง - การ exclude
    # install path ก่อนจะ copy/รันอะไรเลยช่วยกัน Defender กักกันมันระหว่าง
    # ติดตั้ง มีผลกับ Windows Defender เท่านั้น; AV ขององค์กรที่จัดการจาก
    # ส่วนกลางต้องให้ทีม IT/security เพิ่ม allowlist เอง สคริปต์นี้ทำแทน
    # ไม่ได้
    try {
        Add-MpPreference -ExclusionPath $installDir -ErrorAction Stop
        Write-Host "Added Windows Defender exclusion for $installDir"
    } catch {
        Write-Warning "Could not add a Defender exclusion (Defender may be managed centrally by IT policy, or not present) - continuing anyway."
    }

    # หยุดและลบการติดตั้งเดิมก่อนเสมอ ก่อนจะแตะไฟล์ใดๆ - service ที่กำลัง
    # รันจะถือไฟล์ exe ของตัวเองค้างไว้ ดังนั้นการ copy ตัวใหม่ทับจะพังด้วย
    # "cannot access the file, being used by another process" ถ้าทำผิด
    # ลำดับ (ยืนยันจากการติดตั้งซ้ำจริง) ใช้ sc.exe delete แทน nssm.exe
    # ตรงนี้โดยตั้งใจ - ต้องทำงานได้แม้ในกรณีที่ไฟล์ตัวเดียวกันที่กำลังจะ
    # ถูกเขียนทับนี่แหละที่ต้องใช้ลบ service ที่ล็อกมันอยู่
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
    # ไม่ต้องใส่ quote รอบ $configPath: install dir ตั้งใจอยู่ใต้
    # C:\ProgramData (ไม่มีช่องว่าง) ไม่ใช่ C:\Program Files - ยืนยันแล้วว่า
    # "set AppParameters" ของ NSSM เองจะตัดอักขระ quote ที่ฝังไว้ทิ้งตอน
    # ประกอบค่านี้กลับมา ซึ่งจะทำให้ path ที่มีช่องว่างถูกตัดขาดที่ช่องว่าง
    # แรกแบบเงียบๆ (เช่น "-config C:\Program" แล้ว "Files\..." ที่เหลือ
    # ค้างและถูกมองข้ามไป) โดยไม่มี error ให้เห็นเลย
    & $nssmPath set $serviceName AppParameters "-run -config $configPath"
    & $nssmPath set $serviceName AppDirectory $installDir
    & $nssmPath set $serviceName DisplayName "OptiFleet AI Agent"
    & $nssmPath set $serviceName Description "OptiFleet AI fleet telemetry & management agent"
    & $nssmPath set $serviceName Start SERVICE_AUTO_START
    & $nssmPath set $serviceName AppStdout (Join-Path $logDir "service-stdout.log")
    & $nssmPath set $serviceName AppStderr (Join-Path $logDir "service-stderr.log")

    # credential ที่สร้างเฉพาะองค์กรนี้ - ต้องตรงกับแถวขององค์กรนี้ในตาราง
    # `organizations` ของ central server (agent_auth_token /
    # agent_hmac_secret) ไม่ได้แชร์กับองค์กรอื่นบน deployment นี้ - ให้ถือว่า
    # ไฟล์นี้เป็นข้อมูลอ่อนไหว AppEnvironmentExtra ของ NSSM เองคือสิ่งที่
    # service process ที่กำลังรันเห็นจริงๆ ไม่มีปัญหาความน่าเชื่อถือแบบที่
    # การจัดการ env ของ kardianos/service ในเส้นทาง self-install แบบเดิม
    # เคยมี
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
