"use client";

import { useMemo, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { getStoredRole } from "@/lib/session";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { runScript, uploadInstaller, ApiError, type UploadedInstaller } from "@/lib/api";
import { DeployProgress, useDeployPercent } from "@/components/deploy/DeployProgress";
import { DeviceSearchSelect } from "@/components/deploy/DeviceSearchSelect";

interface NiniteApp {
  label: string;
  slug: string;
  // Domain used to fetch a real per-app icon via a favicon service — not an
  // asset this bundles itself, since a maintained, complete icon set for
  // ~140 different vendors doesn't exist as an npm package worth adding for
  // this. Google's favicon endpoint resolves practically any domain and
  // degrades to a generic globe glyph rather than a broken image if it
  // can't find one, so a wrong/outdated domain here never breaks the page.
  icon: string;
}

interface NiniteCategory {
  name: string;
  apps: NiniteApp[];
}

// Ninite (ninite.com) builds a small silent-installer .exe on the fly from a
// URL shaped "ninite.com/<slug1>-<slug2>-.../ninite.exe" — this is a
// long-standing, widely-used convention (not an officially documented API).
// The slugs for well-established single-version apps (browsers, 7-Zip, Git,
// etc.) are the long-standing documented ones. The many version-specific
// entries below (.NET Desktop/ASP.NET Core Runtime x64/arm64 8/9/10, the
// various JDK/JRE builds, the VC++ Redistributable years) mirror what
// ninite.com's own catalog currently lists per the screenshots this was
// built from, but Ninite doesn't publish a slug reference for that tier —
// these are a best-effort naming, not verified against every one
// individually. That's a low-risk gap, not a dangerous one: Ninite's
// installer silently skips any slug it doesn't recognize rather than
// failing the whole batch, and the generated URL is always shown below for
// review before anything is dispatched. Anything still missing, or a slug
// that turns out wrong, can go in the free-text field below instead.
const CATALOG: NiniteCategory[] = [
  {
    name: "Web Browsers",
    apps: [
      { label: "Chrome", slug: "chrome", icon: "google.com" },
      { label: "Opera", slug: "opera", icon: "opera.com" },
      { label: "Firefox", slug: "firefox", icon: "mozilla.org" },
      { label: "Edge", slug: "edge", icon: "microsoft.com" },
      { label: "Brave", slug: "brave", icon: "brave.com" },
      { label: "Vivaldi", slug: "vivaldi", icon: "vivaldi.com" },
    ],
  },
  {
    name: "Messaging",
    apps: [
      { label: "Zoom", slug: "zoom", icon: "zoom.us" },
      { label: "Discord", slug: "discord", icon: "discord.com" },
      { label: "Teams", slug: "teams", icon: "microsoft.com" },
      { label: "Pidgin", slug: "pidgin", icon: "pidgin.im" },
      { label: "Thunderbird", slug: "thunderbird", icon: "thunderbird.net" },
      { label: "Trillian", slug: "trillian", icon: "trillian.im" },
    ],
  },
  {
    name: "Media",
    apps: [
      { label: "iTunes", slug: "itunes", icon: "apple.com" },
      { label: "VLC", slug: "vlc", icon: "videolan.org" },
      { label: "AIMP", slug: "aimp", icon: "aimp.ru" },
      { label: "foobar2000", slug: "foobar", icon: "foobar2000.org" },
      { label: "Winamp", slug: "winamp", icon: "winamp.com" },
      { label: "MusicBee", slug: "musicbee", icon: "getmusicbee.com" },
      { label: "Audacity", slug: "audacity", icon: "audacityteam.org" },
      { label: "K-Lite Codecs", slug: "klitecodecs", icon: "codecguide.com" },
      { label: "GOM", slug: "gom", icon: "gomlab.com" },
      { label: "Spotify", slug: "spotify", icon: "spotify.com" },
      { label: "CCCP", slug: "cccp", icon: "cccp-project.net" },
      { label: "MediaMonkey", slug: "mediamonkey", icon: "mediamonkey.com" },
      { label: "HandBrake", slug: "handbrake", icon: "handbrake.fr" },
    ],
  },
  {
    name: ".NET",
    apps: [
      { label: ".NET 4.8.1", slug: "dotnet481", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime x64 8", slug: "dotnetdesktopx648", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime arm64 8", slug: "dotnetdesktoparm648", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime 8", slug: "dotnetdesktop8", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime x64 9", slug: "dotnetdesktopx649", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime arm64 9", slug: "dotnetdesktoparm649", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime 9", slug: "dotnetdesktop9", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime x64 10", slug: "dotnetdesktopx6410", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime arm64 10", slug: "dotnetdesktoparm6410", icon: "dotnet.microsoft.com" },
      { label: ".NET Desktop Runtime 10", slug: "dotnetdesktop10", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime x64 8", slug: "aspnetcorex648", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime arm64 8", slug: "aspnetcorearm648", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime 8", slug: "aspnetcore8", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime x64 9", slug: "aspnetcorex649", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime arm64 9", slug: "aspnetcorearm649", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime 9", slug: "aspnetcore9", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime x64 10", slug: "aspnetcorex6410", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime arm64 10", slug: "aspnetcorearm6410", icon: "dotnet.microsoft.com" },
      { label: "ASP.NET Core Runtime 10", slug: "aspnetcore10", icon: "dotnet.microsoft.com" },
    ],
  },
  {
    name: "Java",
    apps: [
      { label: "Java (AdoptOpenJDK x64 8)", slug: "jrex64adopt", icon: "adoptium.net" },
      { label: "Java (AdoptOpenJDK 8)", slug: "jreadopt", icon: "adoptium.net" },
      { label: "Java (AdoptOpenJDK x64 11)", slug: "jdkx64adopt11", icon: "adoptium.net" },
      { label: "Java (AdoptOpenJDK x64 17)", slug: "jdkx64adopt17", icon: "adoptium.net" },
      { label: "Java (AdoptOpenJDK x64 21)", slug: "jdkx64adopt21", icon: "adoptium.net" },
      { label: "Java (AdoptOpenJDK x64 25)", slug: "jdkx64adopt25", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK x64 8)", slug: "jdkx64adopt8", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK 8)", slug: "jdkadopt8", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK x64 11)", slug: "jdkx64adopt11b", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK x64 17)", slug: "jdkx64adopt17b", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK x64 21)", slug: "jdkx64adopt21b", icon: "adoptium.net" },
      { label: "JDK (AdoptOpenJDK x64 25)", slug: "jdkx64adopt25b", icon: "adoptium.net" },
      { label: "JDK (Amazon Corretto x64 8)", slug: "jdkx64corretto8", icon: "aws.amazon.com" },
      { label: "JDK (Amazon Corretto 8)", slug: "jdkcorretto8", icon: "aws.amazon.com" },
      { label: "JDK (Amazon Corretto x64 11)", slug: "jdkx64corretto11", icon: "aws.amazon.com" },
      { label: "JDK (Amazon Corretto x64 17)", slug: "jdkx64corretto17", icon: "aws.amazon.com" },
      { label: "JDK (Amazon Corretto x64 21)", slug: "jdkx64corretto21", icon: "aws.amazon.com" },
      { label: "JDK (Amazon Corretto x64 25)", slug: "jdkx64corretto25", icon: "aws.amazon.com" },
      { label: "JRE (Amazon Corretto x64 8)", slug: "jrex64corretto8", icon: "aws.amazon.com" },
      { label: "JRE (Amazon Corretto 8)", slug: "jrecorretto8", icon: "aws.amazon.com" },
    ],
  },
  {
    name: "Imaging",
    apps: [
      { label: "Krita", slug: "krita", icon: "krita.org" },
      { label: "Blender", slug: "blender", icon: "blender.org" },
      { label: "Paint.NET", slug: "paint.net", icon: "getpaint.net" },
      { label: "GIMP", slug: "gimp", icon: "gimp.org" },
      { label: "IrfanView", slug: "irfanview", icon: "irfanview.com" },
      { label: "XnView", slug: "xnview", icon: "xnview.com" },
      { label: "Inkscape", slug: "inkscape", icon: "inkscape.org" },
      { label: "FastStone", slug: "faststoneimageviewer", icon: "faststone.org" },
      { label: "Greenshot", slug: "greenshot", icon: "getgreenshot.org" },
      { label: "ShareX", slug: "sharex", icon: "getsharex.com" },
    ],
  },
  {
    name: "Documents",
    apps: [
      { label: "Foxit Reader", slug: "foxit", icon: "foxit.com" },
      { label: "LibreOffice", slug: "libreoffice", icon: "libreoffice.org" },
      { label: "SumatraPDF", slug: "sumatrapdf", icon: "sumatrapdfreader.org" },
      { label: "CutePDF", slug: "cutepdf", icon: "cutepdf.com" },
      { label: "OpenOffice", slug: "openoffice", icon: "openoffice.org" },
    ],
  },
  {
    name: "File Sharing",
    apps: [{ label: "qBittorrent", slug: "qbittorrent", icon: "qbittorrent.org" }],
  },
  {
    name: "Online Storage",
    apps: [
      { label: "Dropbox", slug: "dropbox", icon: "dropbox.com" },
      { label: "Google Drive for Desktop", slug: "googledrive", icon: "google.com" },
      { label: "OneDrive", slug: "onedrive", icon: "microsoft.com" },
      { label: "SugarSync", slug: "sugarsync", icon: "sugarsync.com" },
    ],
  },
  {
    name: "Other",
    apps: [
      { label: "Evernote", slug: "evernote", icon: "evernote.com" },
      { label: "Google Earth", slug: "googleearth", icon: "earth.google.com" },
      { label: "Steam", slug: "steam", icon: "store.steampowered.com" },
      { label: "Epic Games Launcher", slug: "epicgameslauncher", icon: "epicgames.com" },
      { label: "KeePass 2", slug: "keepass2", icon: "keepass.info" },
      { label: "Everything", slug: "everything", icon: "voidtools.com" },
      { label: "NV Access", slug: "nvda", icon: "nvaccess.org" },
    ],
  },
  {
    name: "Compression",
    apps: [
      { label: "7-Zip", slug: "7zip", icon: "7-zip.org" },
      { label: "PeaZip", slug: "peazip", icon: "peazip.github.io" },
      { label: "WinRAR", slug: "winrar", icon: "win-rar.com" },
    ],
  },
  {
    name: "VC++ Redistributables",
    apps: [
      { label: "VC Redist x64 2015+", slug: "vcredist2015x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2015+", slug: "vcredist2015x86", icon: "microsoft.com" },
      { label: "VC Redist arm64 2015+", slug: "vcredist2015arm64", icon: "microsoft.com" },
      { label: "VC Redist x64 2013", slug: "vcredist2013x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2013", slug: "vcredist2013x86", icon: "microsoft.com" },
      { label: "VC Redist x64 2012", slug: "vcredist2012x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2012", slug: "vcredist2012x86", icon: "microsoft.com" },
      { label: "VC Redist x64 2010", slug: "vcredist2010x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2010", slug: "vcredist2010x86", icon: "microsoft.com" },
      { label: "VC Redist x64 2008", slug: "vcredist2008x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2008", slug: "vcredist2008x86", icon: "microsoft.com" },
      { label: "VC Redist x64 2005", slug: "vcredist2005x64", icon: "microsoft.com" },
      { label: "VC Redist x86 2005", slug: "vcredist2005x86", icon: "microsoft.com" },
    ],
  },
  {
    name: "Utilities",
    apps: [
      { label: "AnyDesk", slug: "anydesk", icon: "anydesk.com" },
      { label: "TeamViewer 15", slug: "teamviewer15", icon: "teamviewer.com" },
      { label: "ImgBurn", slug: "imgburn", icon: "imgburn.com" },
      { label: "RealVNC Server", slug: "realvncserver", icon: "realvnc.com" },
      { label: "RealVNC Viewer", slug: "realvncviewer", icon: "realvnc.com" },
      { label: "TightVNC", slug: "tightvnc", icon: "tightvnc.com" },
      { label: "Python x64 3", slug: "pythonx64", icon: "python.org" },
      { label: "Python arm64 3", slug: "pythonarm64", icon: "python.org" },
      { label: "Python 3", slug: "python3", icon: "python.org" },
      { label: "Python", slug: "python", icon: "python.org" },
      { label: "Git", slug: "git", icon: "git-scm.com" },
      { label: "FileZilla", slug: "filezilla", icon: "filezilla-project.org" },
      { label: "Revo", slug: "revo", icon: "revouninstaller.com" },
      { label: "Launchy", slug: "launchy", icon: "launchy.net" },
      { label: "WinDirStat", slug: "windirstat", icon: "windirstat.net" },
      { label: "TeraCopy", slug: "teracopy", icon: "codesector.com" },
      { label: "WinSCP", slug: "winscp", icon: "winscp.net" },
      { label: "PuTTY", slug: "putty", icon: "putty.org" },
      { label: "WinMerge", slug: "winmerge", icon: "winmerge.org" },
      { label: "Eclipse", slug: "eclipse", icon: "eclipse.org" },
      { label: "Open-Shell", slug: "openshell", icon: "open-shell.github.io" },
      { label: "InfraRecorder", slug: "infrarecorder", icon: "infrarecorder.org" },
      { label: "Glary", slug: "glaryutilities", icon: "glarysoft.com" },
      { label: "CCleaner", slug: "ccleaner", icon: "ccleaner.com" },
    ],
  },
  {
    name: "Security",
    apps: [
      { label: "Malwarebytes", slug: "malwarebytes", icon: "malwarebytes.com" },
      { label: "Avast", slug: "avastfree", icon: "avast.com" },
      { label: "AVG", slug: "avgfree", icon: "avg.com" },
      { label: "Avira", slug: "avira", icon: "avira.com" },
      { label: "SUPERAntiSpyware", slug: "superantispyware", icon: "superantispyware.com" },
      { label: "Spybot 2", slug: "spybot2", icon: "safer-networking.org" },
    ],
  },
  {
    name: "Developer Tools",
    apps: [
      { label: "Notepad++", slug: "notepadplusplus", icon: "notepad-plus-plus.org" },
      { label: "Visual Studio Code", slug: "vscode", icon: "code.visualstudio.com" },
      { label: "Cursor", slug: "cursor", icon: "cursor.com" },
    ],
  },
];

// Ninite has no icon API of its own — the favicon service gives a real,
// recognizable per-vendor mark for very little cost, and quietly falls back
// to a blank/generic image (never a broken-image glyph) for any domain it
// doesn't recognize, so an occasional wrong domain above just looks plain
// rather than broken.
function AppIcon({ domain }: { domain: string }) {
  return (
    <img
      src={`https://www.google.com/s2/favicons?sz=32&domain=${domain}`}
      alt=""
      width={16}
      height={16}
      className="h-4 w-4 shrink-0 rounded-sm"
      loading="lazy"
    />
  );
}

// Emits "STATUS:<stage>" / "PROGRESS:<0-100>" lines the run_script executor
// now streams live (internal/executor/executor.go's runScript, mirroring
// how network_diagnostic already streamed) — DeployProgress below parses
// these out of commandOutputs. Real, byte-accurate progress for the
// download (a manual HttpWebRequest read-loop, since Invoke-WebRequest/
// WebClient give no live progress from a headless script); "installing" is
// necessarily indeterminate — no external silent installer (Ninite's or
// otherwise) reports its own progress, so there is nothing truthful to show
// a percentage for once the download finishes.
function downloadLoop(destVar: string): string[] {
  return [
    `$respStream = $resp.GetResponseStream()`,
    `$fileStream = [System.IO.File]::Create(${destVar})`,
    `$buffer = New-Object byte[] 65536`,
    `$readTotal = 0`,
    `$lastPct = -1`,
    `while (($read = $respStream.Read($buffer, 0, $buffer.Length)) -gt 0) {`,
    `    $fileStream.Write($buffer, 0, $read)`,
    `    $readTotal += $read`,
    `    if ($resp.ContentLength -gt 0) {`,
    `        $pct = [math]::Floor(($readTotal / $resp.ContentLength) * 100)`,
    `        if ($pct -ne $lastPct) { Write-Output "PROGRESS:$pct"; $lastPct = $pct }`,
    `    }`,
    `}`,
    `$fileStream.Close()`,
    `$respStream.Close()`,
    `$resp.Close()`,
  ];
}

function buildNiniteScript(slugs: string[]): { url: string; script: string } {
  const url = `https://ninite.com/${slugs.join("-")}/ninite.exe`;
  const script = [
    `$ErrorActionPreference = "Stop"`,
    `Write-Output "STATUS:downloading"`,
    `$dest = Join-Path $env:TEMP "ninite-deploy-$(Get-Random).exe"`,
    `$req = [System.Net.HttpWebRequest]::Create("${url}")`,
    `$resp = $req.GetResponse()`,
    ...downloadLoop("$dest"),
    `Write-Output "STATUS:installing"`,
    // -NoNewWindow matters here specifically because this script's own
    // stdout/stderr are already redirected (piped back to the dashboard for
    // live progress) — verified on real hardware that Start-Process without
    // it hung/failed once this agent build started streaming output, where
    // the older buffered-output build had run the identical Ninite install
    // fine. Without -NoNewWindow, Start-Process's default launch path
    // behaves differently when the calling process has no real console of
    // its own (true for both "piped output" and "running as a Windows
    // service"), which this agent always is.
    // -PassThru + an explicit exit-code check matters: without it, this
    // script only ever reports failure when PowerShell itself throws
    // (a hang timeout, a parse error) — a silent installer that exits
    // non-zero (a real failure) would otherwise sail through as
    // "Completed successfully" purely because nothing crashed. 3010 is
    // excluded deliberately — Windows Installer's own convention for
    // "succeeded, but a reboot is needed," not a failure.
    `$proc = Start-Process -FilePath $dest -NoNewWindow -Wait -PassThru`,
    `if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "installer exited with code $($proc.ExitCode)" }`,
    `Remove-Item $dest -Force -ErrorAction SilentlyContinue`,
    `Write-Output "STATUS:done"`,
  ].join("\n");
  return { url, script };
}

// A sensible starting point per file type — every real installer's actual
// silent switches vary by vendor, so this is a starting point to edit, never
// trusted as-is. $file is defined by buildCustomScript below before this
// line runs. Checks the real exit code before declaring success — see
// buildNiniteScript's comment on why that matters.
function defaultInstallCommand(filename: string): string {
  const exitCheck = `if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "installer exited with code $($proc.ExitCode)" }`;
  if (filename.toLowerCase().endsWith(".msi")) {
    return `$proc = Start-Process msiexec.exe -ArgumentList "/i", "\`"$file\`"", "/quiet", "/norestart" -NoNewWindow -Wait -PassThru; ${exitCheck}`;
  }
  return `$proc = Start-Process -FilePath $file -ArgumentList "/S" -NoNewWindow -Wait -PassThru; ${exitCheck}`;
}

function buildCustomScript(uploaded: UploadedInstaller, installCommand: string): string {
  return [
    `$ErrorActionPreference = "Stop"`,
    // The agent hub's own HTTPS listener uses a self-signed cert (see
    // dist-agent-deploy-global/optifleet-cert.pem) — the Go agent pins it
    // explicitly for its own requests, but a plain Invoke-WebRequest inside
    // this script has no such trust configured and fails with "Could not
    // establish trust relationship for the SSL/TLS secure channel" against
    // Windows PowerShell 5.1's default trust store (verified on real
    // hardware). A `ServerCertificateValidationCallback = { $true }`
    // scriptblock looks like the obvious fix but actually fails differently
    // ("There is no Runspace available to run scripts in this thread") —
    // the TLS handshake callback runs on a worker thread with no
    // PowerShell runspace bound to it, so a PS scriptblock can't execute
    // there at all. A compiled ICertificatePolicy type has no such
    // requirement, which is why this goes through Add-Type rather than a
    // one-line callback — also verified by hitting the exact failure above
    // on real hardware first.
    `Add-Type @"\nusing System.Net;\nusing System.Security.Cryptography.X509Certificates;\npublic class TrustAllCertsPolicy : ICertificatePolicy {\n    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {\n        return true;\n    }\n}\n"@`,
    `[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy`,
    // Windows PowerShell 5.1's .NET Framework defaults to an older TLS
    // version that the agent hub (TLS 1.2 minimum) rejects outright —
    // verified on real hardware as a *different* error than the cert one
    // above ("An unexpected error occurred on a send" mid-handshake, not
    // a trust failure), so both fixes are needed together, not either alone.
    `[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12`,
    `Write-Output "STATUS:downloading"`,
    `$file = Join-Path $env:TEMP "${uploaded.filename}"`,
    `$req = [System.Net.HttpWebRequest]::Create("${uploaded.downloadUrl}")`,
    `$req.Headers.Add("Authorization", "Bearer ${uploaded.agentAuthToken}")`,
    `$resp = $req.GetResponse()`,
    ...downloadLoop("$file"),
    `Write-Output "STATUS:installing"`,
    installCommand,
    `Remove-Item $file -Force -ErrorAction SilentlyContinue`,
    `Write-Output "STATUS:done"`,
  ].join("\n");
}

function SoftwareDeploy({ username }: { username: string }) {
  const role = getStoredRole();
  const { agents, commandOutputs } = useDashboardSocket();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status === "online"), [agents]);

  const [agentId, setAgentId] = useState("");

  // Ninite mode state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customSlugs, setCustomSlugs] = useState("");
  const [niniteBusy, setNiniteBusy] = useState(false);
  const [niniteResult, setNiniteResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [niniteCommandId, setNiniteCommandId] = useState<string | null>(null);

  // Custom installer mode state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<UploadedInstaller | null>(null);
  const [installCommand, setInstallCommand] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  const [customResult, setCustomResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [customCommandId, setCustomCommandId] = useState<string | null>(null);

  const slugs = useMemo(() => {
    const extra = customSlugs
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return [...selected, ...extra];
  }, [selected, customSlugs]);

  const { url, script } = useMemo(() => buildNiniteScript(slugs), [slugs]);
  const customScript = useMemo(() => (uploaded ? buildCustomScript(uploaded, installCommand) : ""), [uploaded, installCommand]);

  const niniteOutput = niniteCommandId ? commandOutputs[niniteCommandId] : undefined;
  const ninitePercent = useDeployPercent(niniteCommandId, niniteOutput);

  const customOutput = customCommandId ? commandOutputs[customCommandId] : undefined;
  const customPercent = useDeployPercent(customCommandId, customOutput);

  if (role !== "admin") {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  function toggle(slug: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleNiniteDeploy(): Promise<void> {
    if (!agentId || slugs.length === 0) return;
    setNiniteBusy(true);
    setNiniteResult(null);
    setNiniteCommandId(null);
    try {
      const res = await runScript(agentId, script);
      const result = res.results[0];
      if (result?.dispatched) {
        setNiniteCommandId(result.commandId);
      } else {
        setNiniteResult({ ok: false, message: `${agentId} is not currently connected — the command was not delivered.` });
      }
    } catch (err) {
      setNiniteResult({ ok: false, message: err instanceof ApiError ? err.message : "Dispatch failed." });
    } finally {
      setNiniteBusy(false);
    }
  }

  async function handleFileChosen(): Promise<void> {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploadBusy(true);
    setUploadError(null);
    setUploaded(null);
    try {
      const res = await uploadInstaller(file);
      setUploaded(res);
      setInstallCommand(defaultInstallCommand(res.filename));
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleCustomDeploy(): Promise<void> {
    if (!agentId || !uploaded || !installCommand.trim()) return;
    setCustomBusy(true);
    setCustomResult(null);
    setCustomCommandId(null);
    try {
      const res = await runScript(agentId, customScript);
      const result = res.results[0];
      if (result?.dispatched) {
        setCustomCommandId(result.commandId);
      } else {
        setCustomResult({ ok: false, message: `${agentId} is not currently connected — the command was not delivered.` });
      }
    } catch (err) {
      setCustomResult({ ok: false, message: err instanceof ApiError ? err.message : "Dispatch failed." });
    } finally {
      setCustomBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <span className="material-symbols-outlined text-[24px]">install_desktop</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Software Deploy</h1>
            <p className="text-xs text-ink-muted">Push a one-time software install to a chosen device.</p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-ink-secondary">
          <span className="material-symbols-outlined text-[16px] text-status-warning">warning</span>
          <p>
            This runs a real script as SYSTEM on the target device. Review the generated command below before
            dispatching. Installs must finish within 5 minutes — keep it to one installer at a time.
          </p>
        </div>

        <div className="glass-card rounded-xl p-card-padding">
          <DeviceSearchSelect agentId={agentId} onChange={setAgentId} onlineAgents={onlineAgents} />
        </div>

        <div>
          <h2 className="text-sm font-semibold text-ink-primary">Option A — pick from Ninite's catalog</h2>
        </div>

        {/* CSS multi-column, not grid: a grid row sizes every cell in it to
            its tallest neighbor, so a 6-app category (Web Browsers) sitting
            next to a 19-app one (.NET) left a huge dead gap underneath the
            short one before the next row could start. Columns instead flow
            each category directly beneath whichever came before it in the
            same column, packing tightly like ninite.com's own layout. */}
        <div className="glass-card columns-1 gap-6 rounded-xl p-card-padding sm:columns-2 lg:columns-3 2xl:columns-4">
          {CATALOG.map((cat) => (
            <div key={cat.name} className="mb-6 break-inside-avoid">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{cat.name}</h3>
              <div className="mt-2 flex flex-col gap-1.5">
                {cat.apps.map((app) => (
                  <label key={app.slug} className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={selected.has(app.slug)}
                      onChange={() => toggle(app.slug)}
                      className="h-4 w-4 shrink-0 rounded border-border accent-accent"
                    />
                    <AppIcon domain={app.icon} />
                    <span className="truncate">{app.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="glass-card flex flex-col gap-3 rounded-xl p-card-padding">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Additional apps (Ninite slugs, comma-separated)
            </label>
            <input
              type="text"
              value={customSlugs}
              onChange={(e) => setCustomSlugs(e.target.value)}
              placeholder="e.g. vscode, teamviewer15"
              className="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent"
            />
          </div>

          {slugs.length > 0 && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Generated command (reviewed before dispatch)
              </label>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-border bg-page p-3 text-xs text-ink-secondary">
                {script}
              </pre>
              <p className="mt-1 text-xs text-ink-muted">URL: {url}</p>
            </div>
          )}

          {niniteResult && (
            <p className={`text-sm ${niniteResult.ok ? "text-status-good" : "text-status-critical"}`}>
              {niniteResult.message}
            </p>
          )}
          <DeployProgress commandId={niniteCommandId} output={niniteOutput} />

          {/* Hidden once a result lands — the message/progress above already
              shows ✓/✗, so the button disappears rather than sitting there
              inviting a re-click on a command that already ran. */}
          {!niniteOutput?.done && (
            <button
              type="button"
              onClick={handleNiniteDeploy}
              disabled={niniteBusy || Boolean(niniteCommandId) || !agentId || slugs.length === 0}
              className="flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">install_desktop</span>
              {niniteBusy ? "Dispatching…" : niniteCommandId ? `Deploying… ${ninitePercent}%` : "Deploy"}
            </button>
          )}
        </div>

        <div>
          <h2 className="text-sm font-semibold text-ink-primary">Option B — upload your own installer</h2>
        </div>

        <div className="glass-card flex flex-col gap-3 rounded-xl p-card-padding">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Installer file (.exe/.msi)</label>
            <div className="mt-1 flex items-center gap-2">
              <input ref={fileInputRef} type="file" accept=".exe,.msi" className="text-sm text-ink-secondary" />
              <button
                type="button"
                onClick={handleFileChosen}
                disabled={uploadBusy}
                className="shrink-0 rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary hover:bg-gridline disabled:opacity-50"
              >
                {uploadBusy ? "Uploading…" : "Upload"}
              </button>
            </div>
            {uploadError && <p className="mt-1 text-xs text-status-critical">{uploadError}</p>}
            {uploaded && (
              <p className="mt-1 text-xs text-status-good">
                Uploaded {uploaded.filename} ({Math.round(uploaded.bytes / 1024)} KB)
              </p>
            )}
          </div>

          {uploaded && (
            <>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Install command ($file is the downloaded installer's path — edit to match this installer's real
                  silent-install switches)
                </label>
                <textarea
                  value={installCommand}
                  onChange={(e) => setInstallCommand(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 font-mono text-xs text-ink-primary outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Generated command (reviewed before dispatch)
                </label>
                <pre className="mt-1 overflow-x-auto rounded-lg border border-border bg-page p-3 text-xs text-ink-secondary">
                  {customScript}
                </pre>
              </div>

              {customResult && (
                <p className={`text-sm ${customResult.ok ? "text-status-good" : "text-status-critical"}`}>
                  {customResult.message}
                </p>
              )}
              <DeployProgress commandId={customCommandId} output={customOutput} />

              {!customOutput?.done && (
                <button
                  type="button"
                  onClick={handleCustomDeploy}
                  disabled={customBusy || Boolean(customCommandId) || !agentId || !installCommand.trim()}
                  className="flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">install_desktop</span>
                  {customBusy ? "Dispatching…" : customCommandId ? `Deploying… ${customPercent}%` : "Deploy"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default function SoftwareDeployPage() {
  return <AuthGate>{(username) => <SoftwareDeploy username={username} />}</AuthGate>;
}
