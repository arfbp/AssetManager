"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { getStoredRole } from "@/lib/session";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { runScript, ApiError } from "@/lib/api";
import { DeployProgress, useDeployPercent } from "@/components/deploy/DeployProgress";
import { DeviceSearchSelect } from "@/components/deploy/DeviceSearchSelect";

interface InstalledProgram {
  name: string;
  version: string;
  publisher: string;
  uninstallString: string;
  quietUninstallString: string;
}

// ดึงข้อมูลจาก registry 3 ตำแหน่งเดียวกับที่ Control Panel's "Programs and
// Features" อ่าน — HKLM (64-bit), HKLM\WOW6432Node (แอป 32-bit บน OS 64-bit)
// และ HKCU (ติดตั้งระดับ per-user) ส่วน entry ที่ SystemComponent=1 หรือ
// ไม่มี DisplayName คือชิ้นส่วนภายในของ Windows เอง (patch, runtime ที่ลง
// ทะเบียนเป็น component ฯลฯ) ไม่ใช่สิ่งที่ operator ต้องการ uninstall —
// กรองออกด้วยหลักการเดียวกับที่ Control Panel ซ่อนพวกนี้
const SCAN_SCRIPT = [
  `$ErrorActionPreference = "Stop"`,
  `$paths = @(`,
  `    "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",`,
  `    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",`,
  `    "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"`,
  `)`,
  `$apps = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |`,
  `    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } |`,
  `    Select-Object @{N="name";E={$_.DisplayName}}, @{N="version";E={"$($_.DisplayVersion)"}}, @{N="publisher";E={"$($_.Publisher)"}}, @{N="uninstallString";E={"$($_.UninstallString)"}}, @{N="quietUninstallString";E={"$($_.QuietUninstallString)"}} |`,
  `    Sort-Object name -Unique`,
  `Write-Output "INSTALLED_JSON:$(ConvertTo-Json -InputObject @($apps) -Compress)"`,
].join("\n");

function parseInstalledPrograms(lines: string[]): InstalledProgram[] {
  const line = lines.find((l) => l.startsWith("INSTALLED_JSON:"));
  if (!line) return [];
  try {
    const parsed = JSON.parse(line.slice("INSTALLED_JSON:".length));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// การ uninstall แบบ MSI (UninstallString ที่หน้าตาแบบ "MsiExec.exe /X{GUID}")
// รองรับ silent flag มาตรฐาน ส่วนตัวอื่นแต่ละ vendor มี silent switch ที่ต่างกัน
// จริง ๆ เหตุผลเดียวกับ defaultInstallCommand ของ Software Deploy — นี่เป็นแค่
// จุดเริ่มต้นที่ operator ต้องตรวจและแก้ไขเอง ไม่ใช่ค่าที่เชื่อถือได้ทันที
function defaultUninstallCommand(app: InstalledProgram): string {
  const raw = app.quietUninstallString || app.uninstallString;
  const isMsi = /^msiexec(\.exe)?\s+\/x/i.test(raw.trim());
  const command = isMsi && !app.quietUninstallString ? `${raw} /quiet /norestart` : raw;
  // string แบบ single-quote ใน PowerShell ต้อง escape แค่ quote ที่อยู่ข้างใน
  // ตัวมันเอง (ทำซ้ำสองตัว) — ไม่ต้องกังวลเรื่อง $ หรือ backtick ถูกตีความ
  // เหมือนตอนที่เคยสร้างเป็น double-quoted string
  const psLiteral = command.replace(/'/g, "''");
  return [
    // UninstallString ใน registry คือ command line เต็มรูปแบบ (path ที่มี
    // quote ครอบพร้อม argument ของมันเอง หรือบางทีก็เป็น path ไม่มี quote ที่
    // ตัวมันเองมี space อยู่) ไม่ใช่แค่ path ของ executable เฉย ๆ — โค้ดตรงนี้
    // เลย parse แยกเป็น exe path + argument string แล้วเรียกด้วย Start-Process
    // โดยตรง แทนที่จะส่งให้ `cmd.exe /c` แบบที่เคยทำไว้ตอนแรก
    // กฎการ strip quote ของ cmd.exe ตอนใช้ /c เป็นที่รู้กันว่ามีปัญหากับเคส
    // แบบนี้พอดี: ยืนยันแล้วบนเครื่องจริงว่า path ที่มี quote ครอบและมี space
    // เมื่อสั่งผ่าน `cmd /c "<path> args"` จะถูกตัดผิดที่ space ตัวแรก
    // ('C:\Program' ไม่ถูกจำว่าเป็นคำสั่งภายในหรือภายนอก) — ส่วน -FilePath/
    // -ArgumentList ของ Start-Process จะเรียก process เป้าหมายตรง ๆ โดยไม่มี
    // shell กลางมาตีความ quote ซ้ำอีกชั้นเลย
    `$raw = '${psLiteral}'`,
    `if ($raw.StartsWith('"')) {`,
    `    $i = $raw.IndexOf('"', 1)`,
    `    $exePath = $raw.Substring(1, $i - 1)`,
    `    $exeArgs = $raw.Substring($i + 1).Trim()`,
    `} elseif (Test-Path -LiteralPath $raw -PathType Leaf) {`,
    `    $exePath = $raw`,
    `    $exeArgs = ""`,
    `} else {`,
    // กรณีไม่มี quote ครอบ และ raw string ทั้งเส้นก็ไม่ใช่ไฟล์จริง (แปลว่า
    // ต้องมี argument ต่อท้ายอยู่) — ลองตัดทีละ prefix คั่นด้วย space แล้ว
    // เลือกอันที่ยาวที่สุดที่เป็นไฟล์จริง เพราะ path ที่ vendor ให้มาแบบไม่มี
    // quote ก็อาจมี space อยู่ในตัวมันเองได้เหมือนกัน (เช่น "C:\Program
    // Files (x86)\Vendor\uninstall.exe -s" ที่ไม่มี quote เลย)
    `    $exePath = $null`,
    `    $searchFrom = 0`,
    `    while ($true) {`,
    `        $spaceIdx = $raw.IndexOf(' ', $searchFrom)`,
    `        if ($spaceIdx -lt 0) { break }`,
    `        $candidate = $raw.Substring(0, $spaceIdx)`,
    `        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $exePath = $candidate; $exeArgs = $raw.Substring($spaceIdx + 1).Trim() }`,
    `        $searchFrom = $spaceIdx + 1`,
    `    }`,
    `    if (-not $exePath) {`,
    `        $spaceIdx = $raw.IndexOf(' ')`,
    `        if ($spaceIdx -ge 0) { $exePath = $raw.Substring(0, $spaceIdx); $exeArgs = $raw.Substring($spaceIdx + 1).Trim() } else { $exePath = $raw; $exeArgs = "" }`,
    `    }`,
    `}`,
    // ใช้ -PassThru พร้อมเช็ค exit code ตรง ๆ: uninstaller จริงของบาง vendor
    // เขียนข้อความ diagnostic ที่ดูน่ากลัวลง stderr แม้รันสำเร็จจริง ๆ ก็ตาม
    // (ยืนยันแล้วบนเครื่องจริง — uninstaller ของ Brave ที่ทำจาก Chromium ขึ้น
    // log "Access is denied" ตอนพยายาม relaunch ตัวเองเพื่อเปิด dialog
    // ยืนยันที่มันไม่จำเป็นต้องมีภายใต้ session แบบ SYSTEM/ไม่มี desktop
    // แต่สุดท้ายก็รันจบและ exit 0) — เพราะงั้นการตัดสินสำเร็จ/ล้มเหลวจึงดูจาก
    // exit code จริงเท่านั้น ไม่ใช่ดูว่า output มีคำว่า "error" โผล่มาหรือไม่
    // ส่วน 3010 คือรหัสของ Windows Installer ที่แปลว่า "สำเร็จ แต่ต้อง
    // reboot" ไม่ใช่ความล้มเหลว
    //
    // ใช้การรอแบบมีเวลาจำกัดแทน -Wait แบบไม่มีกำหนด: เมื่อโปรแกรมไม่มี
    // QuietUninstallString ลงทะเบียนไว้ และ UninstallString ธรรมดาก็ไม่ใช่
    // แบบ MSI โค้ดตรงนี้จะไปเรียก uninstaller แบบ interactive จริงของ vendor
    // ซึ่งเปิด GUI wizard แล้วค้างรอการคลิกที่ไม่มีทางเกิดขึ้น (ยืนยันแล้วบน
    // เครื่องจริงกับ uninst.exe ของ Sangfor SecoClient: มันค้างจนกระทั่ง
    // timeout 5 นาทีของ run_script ที่ครอบอยู่ฆ่าคำสั่งทั้งหมดทิ้งโดยไม่มี
    // diagnostic ที่เป็นประโยชน์เลย) การฆ่า process tree แล้วโยน error message
    // เฉพาะเจาะจงหลัง watchdog ที่สั้นกว่ามากนี้ ช่วยเปลี่ยนให้กลายเป็น error
    // ที่เร็วและแก้ไขได้จริงแทน
    `if ($exeArgs) { $proc = Start-Process -FilePath $exePath -ArgumentList $exeArgs -NoNewWindow -PassThru } else { $proc = Start-Process -FilePath $exePath -NoNewWindow -PassThru }`,
    // การอ่าน .Handle ทันทีบังคับให้ .NET เก็บ process handle ที่ถูกต้องไว้ —
    // ถ้าข้ามบรรทัดนี้ $proc.ExitCode จะเงียบ ๆ กลับมาเป็นค่าว่างทันทีที่ใช้
    // WaitForExit(ms) แทน -Wait (ยืนยันโดยตรงแล้ว: ถ้าไม่มีบรรทัดนี้ process
    // ที่ exit ด้วยโค้ด 7 จะรายงาน ExitCode เป็น "")
    `$proc.Handle | Out-Null`,
    `if (-not $proc.WaitForExit(90000)) {`,
    `    Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID", $proc.Id, "/T", "/F" -NoNewWindow -Wait -ErrorAction SilentlyContinue`,
    `    throw "uninstaller did not finish within 90s and was terminated - it likely opened an interactive dialog with no one to click it (no silent switch registered for this program). Edit the command above to add the vendor's silent/quiet uninstall flag and try again."`,
    `}`,
    `if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "uninstaller exited with code $($proc.ExitCode)" }`,
    // exit code 0 อย่างเดียวไม่ใช่หลักฐานว่าเกิดอะไรขึ้นจริง: ยืนยันแล้วบน
    // เครื่องจริงกับ GOM Player (ไม่มี QuietUninstallString) — uninstaller
    // แบบ interactive ของมันรันขึ้นได้ปกติ exit 0 ทันที แต่ registry entry,
    // install directory และ desktop shortcut ยังอยู่ครบเหมือนเดิมทุกอย่าง
    // เดาว่าภายใต้ session แบบ SYSTEM/ไม่มี desktop มันคงวาด confirmation
    // dialog ไม่ได้ เลยแค่ยอมแพ้เงียบ ๆ แทนที่จะค้าง (ซึ่งเป็นเคสที่ watchdog
    // 90 วินาทีด้านบนจับได้) แล้วให้ exit code แบบ "สำเร็จ" ออกมา การ query
    // registry uninstall key ชุดเดียวกับที่ตัว scan อ่านซ้ำอีกครั้งเพื่อเช็คว่า
    // DisplayName นี้หายไปจริงหรือยัง เป็นวิธีเดียวที่จับเคสนี้ได้ ส่วน child
    // process ที่ค้างอยู่ก็จะไม่โผล่มาให้เห็นตรงนี้เหมือนกัน เพราะงั้นนี่ไม่ได้
    // ซ้ำซ้อนกับ watchdog ด้านบน แต่เป็นเคสที่ watchdog จับไม่ได้ต่างหาก
    `$stillInstalled = Get-ItemProperty -Path @("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*") -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${app.name.replace(/'/g, "''")}' }`,
    `if ($stillInstalled) { throw "uninstaller exited 0 but '${app.name.replace(/'/g, "''")}' is still registered as installed - it likely needs an interactive desktop session to actually run (no silent switch available). Try uninstalling it manually on the device, or edit the command above if you know its real silent-uninstall flag." }`,
  ].join("\n");
}

function buildUninstallScript(installCommand: string): string {
  return [`$ErrorActionPreference = "Stop"`, `Write-Output "STATUS:uninstalling"`, installCommand, `Write-Output "STATUS:done"`].join(
    "\n",
  );
}

function ProgramCard({ app, onUninstall }: { app: InstalledProgram; onUninstall: (app: InstalledProgram) => void }) {
  return (
    <div className="glass-card flex flex-col gap-2 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <span className="material-symbols-outlined text-[20px]">apps</span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-ink-primary" title={app.name}>
            {app.name}
          </h3>
          <p className="truncate text-xs text-ink-muted">{app.publisher || "Unknown publisher"}</p>
        </div>
      </div>
      {app.version && <p className="text-xs text-ink-secondary">Version {app.version}</p>}
      <button
        type="button"
        onClick={() => onUninstall(app)}
        className="mt-1 flex w-fit items-center gap-1.5 rounded-lg border border-status-critical/30 bg-status-critical/5 px-3 py-1.5 text-xs font-medium text-status-critical hover:bg-status-critical/10"
      >
        <span className="material-symbols-outlined text-[16px]">delete</span>
        Uninstall
      </button>
    </div>
  );
}

function UninstallSoftware({ username }: { username: string }) {
  const role = getStoredRole();
  const { agents, commandOutputs } = useDashboardSocket();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status === "online"), [agents]);

  const [agentId, setAgentId] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanCommandId, setScanCommandId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [programs, setPrograms] = useState<InstalledProgram[] | null>(null);
  const [programQuery, setProgramQuery] = useState("");

  const [selectedApp, setSelectedApp] = useState<InstalledProgram | null>(null);
  const [uninstallCommand, setUninstallCommand] = useState("");
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [uninstallCommandId, setUninstallCommandId] = useState<string | null>(null);
  const [uninstallResult, setUninstallResult] = useState<{ ok: boolean; message: string } | null>(null);

  const scanOutput = scanCommandId ? commandOutputs[scanCommandId] : undefined;
  const uninstallOutput = uninstallCommandId ? commandOutputs[uninstallCommandId] : undefined;
  const uninstallPercent = useDeployPercent(uninstallCommandId, uninstallOutput);
  const filteredPrograms = useMemo(() => {
    if (!programs) return [];
    const q = programQuery.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter((p) => p.name.toLowerCase().includes(q) || p.publisher.toLowerCase().includes(q));
  }, [programs, programQuery]);

  if (role !== "admin") {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  function resetForNewDevice(id: string): void {
    setAgentId(id);
    setPrograms(null);
    setScanCommandId(null);
    setScanError(null);
    setSelectedApp(null);
    setUninstallResult(null);
    setUninstallCommandId(null);
  }

  async function handleScan(): Promise<void> {
    if (!agentId) return;
    setScanBusy(true);
    setScanError(null);
    setPrograms(null);
    setScanCommandId(null);
    try {
      const res = await runScript(agentId, SCAN_SCRIPT);
      const result = res.results[0];
      if (result?.dispatched) {
        setScanCommandId(result.commandId);
      } else {
        setScanError(`${agentId} is not currently connected — the command was not delivered.`);
      }
    } catch (err) {
      setScanError(err instanceof ApiError ? err.message : "Scan failed.");
    } finally {
      setScanBusy(false);
    }
  }

  // รับผลลัพธ์ของการ scan ทันทีที่มันมาถึง (commandOutputs อัปเดตแบบ live
  // ผ่าน dashboard socket) โดยไม่ต้องให้ผู้ใช้คลิกซ้ำอีกครั้ง
  useEffect(() => {
    if (!scanOutput?.done) return;
    if (scanOutput.error) {
      setScanError(scanOutput.error);
      return;
    }
    setPrograms(parseInstalledPrograms(scanOutput.lines));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOutput?.done]);

  function handlePickApp(app: InstalledProgram): void {
    setSelectedApp(app);
    setUninstallCommand(defaultUninstallCommand(app));
    setUninstallResult(null);
    setUninstallCommandId(null);
  }

  async function handleUninstall(): Promise<void> {
    if (!agentId || !selectedApp || !uninstallCommand.trim()) return;
    setUninstallBusy(true);
    setUninstallResult(null);
    setUninstallCommandId(null);
    try {
      const res = await runScript(agentId, buildUninstallScript(uninstallCommand));
      const result = res.results[0];
      if (result?.dispatched) {
        setUninstallCommandId(result.commandId);
      } else {
        setUninstallResult({ ok: false, message: `${agentId} is not currently connected — the command was not delivered.` });
      }
    } catch (err) {
      setUninstallResult({ ok: false, message: err instanceof ApiError ? err.message : "Dispatch failed." });
    } finally {
      setUninstallBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-status-critical/10 text-status-critical">
            <span className="material-symbols-outlined text-[24px]">delete_sweep</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Uninstall Software</h1>
            <p className="text-xs text-ink-muted">Search for an online device, scan what's installed, and remove it.</p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-ink-secondary">
          <span className="material-symbols-outlined text-[16px] text-status-warning">warning</span>
          <p>This runs a real script as SYSTEM on the target device. Review the generated command before dispatching.</p>
        </div>

        <div className="glass-card flex flex-col gap-3 rounded-xl p-card-padding">
          <DeviceSearchSelect agentId={agentId} onChange={resetForNewDevice} onlineAgents={onlineAgents} />
          <button
            type="button"
            onClick={handleScan}
            disabled={scanBusy || !agentId}
            className="flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">search</span>
            {scanBusy ? "Scanning…" : "Scan installed programs"}
          </button>
          {scanError && <p className="text-sm text-status-critical">✗ {scanError}</p>}
          {!scanError && <DeployProgress commandId={scanCommandId} output={scanOutput} />}
        </div>

        {programs && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-primary">
                {programs.length} program{programs.length === 1 ? "" : "s"} found on {agentId}
              </h2>
              <input
                type="text"
                value={programQuery}
                onChange={(e) => setProgramQuery(e.target.value)}
                placeholder="Filter by name or publisher…"
                className="w-64 rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filteredPrograms.map((app) => (
                <ProgramCard key={`${app.name}-${app.version}`} app={app} onUninstall={handlePickApp} />
              ))}
              {filteredPrograms.length === 0 && (
                <p className="col-span-full py-6 text-center text-sm text-ink-muted">No programs match that filter.</p>
              )}
            </div>
          </>
        )}

      </div>

      {/* ใช้ popup จริง ๆ ไม่ใช่ section แบบ inline ท้ายหน้า — เพราะด้านบนมี
          program card ได้ถึง 80+ ใบ ถ้าเป็น inline section จะอยู่ไกลจาก
          การ์ดที่คลิกไปมาก ต้อง scroll ลงสุดทุกครั้งกว่าจะเจอ การเด้ง popup
          ขึ้นมาทันทีแบบนี้ยังทำให้ขั้นตอน review-and-edit นี้เป็นการ confirm
          ในตัวเลยด้วย ไม่ต้องมีคำถาม "แน่ใจไหม" อีกชั้นซ้อนทับ หลังจาก
          operator เห็นคำสั่งจริงแล้วกด Uninstall ไปแล้ว */}
      {selectedApp && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => !uninstallBusy && setSelectedApp(null)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative z-10 flex w-full max-w-lg flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold text-ink-primary">Uninstall {selectedApp.name}</h2>
              <button
                type="button"
                onClick={() => !uninstallBusy && setSelectedApp(null)}
                className="text-ink-muted hover:text-ink-primary"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <p className="text-xs text-ink-muted">
              This runs a real script as SYSTEM on {agentId} and cannot be undone.
            </p>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Uninstall command (edit if this program needs a specific silent-uninstall switch)
              </label>
              <textarea
                value={uninstallCommand}
                onChange={(e) => setUninstallCommand(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 font-mono text-xs text-ink-primary outline-none focus:border-accent"
              />
            </div>

            {uninstallResult && (
              <p className={`text-sm ${uninstallResult.ok ? "text-status-good" : "text-status-critical"}`}>{uninstallResult.message}</p>
            )}
            <DeployProgress commandId={uninstallCommandId} output={uninstallOutput} />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSelectedApp(null)}
                disabled={uninstallBusy}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
              >
                {uninstallCommandId ? "Close" : "Cancel"}
              </button>
              {/* ซ่อนทันทีที่มีผลลัพธ์ออกมา — DeployProgress ด้านบนแสดง ✓/✗
                  ให้แล้ว ถ้าปุ่ม "Uninstall" ยังค้างอยู่ตรงนี้ก็จะชวนให้กดซ้ำ
                  ทั้งที่คำสั่งรันจบไปแล้ว ทำให้สับสนเปล่า ๆ */}
              {!uninstallOutput?.done && (
                <button
                  type="button"
                  onClick={handleUninstall}
                  disabled={uninstallBusy || Boolean(uninstallCommandId) || !uninstallCommand.trim()}
                  className="flex items-center gap-2 rounded-md bg-status-critical px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                  {uninstallBusy ? "Dispatching…" : uninstallCommandId ? `Uninstalling… ${uninstallPercent}%` : "Uninstall"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function UninstallSoftwarePage() {
  return <AuthGate>{(username) => <UninstallSoftware username={username} />}</AuthGate>;
}
