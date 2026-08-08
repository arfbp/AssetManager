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

// Queries the same three registry locations Control Panel's "Programs and
// Features" reads from — HKLM (64-bit), HKLM\WOW6432Node (32-bit apps on a
// 64-bit OS), and HKCU (per-user installs). SystemComponent=1 entries and
// anything with no DisplayName are Windows' own internal pieces (patches,
// runtimes registered as components, etc.), not something an operator would
// ever mean to uninstall — filtered out the same way Control Panel hides them.
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

// MSI-based uninstalls (UninstallString like "MsiExec.exe /X{GUID}") support
// a standard silent flag; anything else's real silent switches vary by
// vendor, same reasoning as Software Deploy's defaultInstallCommand — this
// is a starting point the operator reviews and edits, never trusted as-is.
function defaultUninstallCommand(app: InstalledProgram): string {
  const raw = app.quietUninstallString || app.uninstallString;
  const isMsi = /^msiexec(\.exe)?\s+\/x/i.test(raw.trim());
  const command = isMsi && !app.quietUninstallString ? `${raw} /quiet /norestart` : raw;
  // PowerShell single-quoted strings need only their own embedded quotes
  // doubled — no $ or backtick interpretation to worry about, unlike the
  // double-quoted string this used to be built as.
  const psLiteral = command.replace(/'/g, "''");
  return [
    // A registry UninstallString is a whole command line (quoted path plus
    // its own arguments, or sometimes an unquoted path that itself contains
    // spaces), not a bare executable path — so it gets parsed into an exe
    // path + argument string here and launched directly with Start-Process,
    // rather than handed to `cmd.exe /c` as originally implemented.
    // cmd.exe's own quote-stripping rule for /c is notorious for exactly
    // this case: verified on real hardware that a quoted, spaced path
    // launched via `cmd /c "<path> args"` comes out the other side
    // mis-split at the first space ('C:\Program' is not recognized as an
    // internal or external command) — Start-Process's own -FilePath/
    // -ArgumentList launches the target process directly, with no
    // intermediate shell to re-interpret the quoting at all.
    `$raw = '${psLiteral}'`,
    `if ($raw.StartsWith('"')) {`,
    `    $i = $raw.IndexOf('"', 1)`,
    `    $exePath = $raw.Substring(1, $i - 1)`,
    `    $exeArgs = $raw.Substring($i + 1).Trim()`,
    `} elseif (Test-Path -LiteralPath $raw -PathType Leaf) {`,
    `    $exePath = $raw`,
    `    $exeArgs = ""`,
    `} else {`,
    // Unquoted AND the raw string itself isn't a real file (so it must
    // carry trailing arguments) — try each space-delimited prefix in turn
    // and keep the longest one that's an actual file, since an unquoted
    // vendor-supplied path can itself contain spaces (e.g. "C:\Program
    // Files (x86)\Vendor\uninstall.exe -s", no quotes at all).
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
    // -PassThru + an explicit exit-code check: a real uninstaller some
    // vendors ship writes alarming-looking diagnostic text to stderr even
    // on a genuinely successful run (verified on real hardware — Brave's
    // Chromium-based uninstaller logs "Access is denied" trying to relaunch
    // itself for a confirmation dialog it doesn't need under a SYSTEM/no-
    // desktop session, then still finishes and exits 0) — so success/
    // failure is judged by the real exit code, never by whether the output
    // merely contains the word "error". 3010 = Windows Installer's
    // "succeeded, reboot needed," not a failure.
    //
    // Bounded wait instead of an indefinite -Wait: when a program has no
    // registered QuietUninstallString and its plain UninstallString isn't
    // MSI-based, this launches the vendor's real interactive uninstaller —
    // which opens a GUI wizard and blocks forever waiting for a click that
    // will never come (verified on real hardware with Sangfor SecoClient's
    // uninst.exe: it hung until the surrounding run_script's own 5-minute
    // timeout killed the whole command with no useful diagnostic). Killing
    // the process tree and throwing a specific message after a much shorter
    // watchdog turns that into a fast, actionable error instead.
    `if ($exeArgs) { $proc = Start-Process -FilePath $exePath -ArgumentList $exeArgs -NoNewWindow -PassThru } else { $proc = Start-Process -FilePath $exePath -NoNewWindow -PassThru }`,
    // Reading .Handle immediately forces .NET to retain a proper process
    // handle — skip this and $proc.ExitCode silently comes back blank once
    // WaitForExit(ms) is used instead of -Wait (verified directly: without
    // this line a process that exits with code 7 reports ExitCode as "").
    `$proc.Handle | Out-Null`,
    `if (-not $proc.WaitForExit(90000)) {`,
    `    Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID", $proc.Id, "/T", "/F" -NoNewWindow -Wait -ErrorAction SilentlyContinue`,
    `    throw "uninstaller did not finish within 90s and was terminated - it likely opened an interactive dialog with no one to click it (no silent switch registered for this program). Edit the command above to add the vendor's silent/quiet uninstall flag and try again."`,
    `}`,
    `if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "uninstaller exited with code $($proc.ExitCode)" }`,
    // Exit code 0 alone isn't proof anything happened: verified on real
    // hardware with GOM Player (no QuietUninstallString) — its interactive
    // uninstaller launched fine, immediately exited 0, and yet the registry
    // entry, install directory, and desktop shortcut were all still there
    // afterwards, unchanged. Under a SYSTEM/no-desktop session it likely
    // couldn't paint its confirmation dialog and just gave up instead of
    // hanging (the case the 90s watchdog above catches) — silently, with a
    // "successful" exit code. Re-querying the same registry uninstall keys
    // the scan itself reads from and confirming this DisplayName is
    // actually gone is the only way to catch that; a hung child process
    // wouldn't be visible here either, so this isn't redundant with the
    // watchdog above, it's the case that one can't catch.
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

  // Picks up the scan's result the moment it lands (commandOutputs updates
  // live via the dashboard socket) rather than requiring a second click.
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

      {/* A real popup, not an inline section at the end of the page — with
          up to 80+ program cards above it, an inline section landed far
          below whichever card was clicked, so reaching it meant scrolling
          all the way down every time. Popping up immediately here also
          means this review-and-edit step IS the confirmation: there's no
          second "are you sure?" stacked on top of it once the operator has
          already seen the exact command and clicked Uninstall. */}
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
              {/* Hidden once a result lands — DeployProgress above already
                  shows ✓/✗, so a still-visible "Uninstall" button here would
                  just invite a confusing second click on a command that
                  already ran. */}
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
