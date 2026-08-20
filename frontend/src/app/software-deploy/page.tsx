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
  // domain ที่ใช้ดึงไอคอนจริงของแต่ละแอปผ่าน favicon service — ไม่ได้ bundle
  // asset เองเพราะ icon set ที่ครบและดูแลต่อเนื่องสำหรับ vendor ~140 เจ้า
  // ไม่มี npm package ที่คุ้มจะเพิ่มเข้ามา favicon endpoint ของ Google
  // resolve ได้แทบทุก domain และ fallback เป็นรูปโลกทั่วไปแทนรูปพังถ้าหาไม่
  // เจอ เลย domain ที่ผิดหรือล้าสมัยตรงนี้ไม่ทำให้หน้าพังเลย
  icon: string;
}

interface NiniteCategory {
  name: string;
  apps: NiniteApp[];
}

// Ninite (ninite.com) จะสร้าง silent-installer .exe เล็ก ๆ ขึ้นมาแบบ on-the-
// fly จาก URL รูปแบบ "ninite.com/<slug1>-<slug2>-.../ninite.exe" — เป็น
// convention ที่ใช้กันมานานและแพร่หลาย (ไม่ใช่ API ที่มี doc อย่างเป็นทางการ)
// slug ของแอปแบบ single-version ที่รู้จักกันดี (browser, 7-Zip, Git ฯลฯ)
// เป็นชุดที่มี doc มานานแล้ว ส่วน entry ที่ระบุ version เยอะ ๆ ด้านล่าง
// (.NET Desktop/ASP.NET Core Runtime x64/arm64 8/9/10, JDK/JRE หลายรุ่น,
// VC++ Redistributable แต่ละปี) อ้างอิงจาก catalog ของ ninite.com ตอนที่
// สร้างไฟล์นี้ แต่ Ninite ไม่มี reference slug อย่างเป็นทางการสำหรับกลุ่มนี้
// — เป็นการตั้งชื่อแบบ best-effort ไม่ได้ verify ทีละตัว แต่ความเสี่ยงต่ำ
// ไม่ถึงขั้นอันตราย เพราะ installer ของ Ninite จะข้าม slug ที่ไม่รู้จักไป
// เฉย ๆ ไม่ทำให้ทั้ง batch fail และ URL ที่ generate ก็โชว์ให้ review ก่อน
// dispatch ทุกครั้งอยู่แล้ว ถ้ามีตัวไหนขาดหรือ slug ผิด ใส่เพิ่มในช่อง
// free-text ด้านล่างแทนได้
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

// Ninite ไม่มี icon API ของตัวเอง — favicon service ให้ mark ของแต่ละ vendor
// ที่จำได้จริง ๆ ในต้นทุนต่ำมาก และ fallback เป็นรูปเปล่า/generic เงียบ ๆ
// (ไม่ใช่ไอคอนพัง) เมื่อเจอ domain ที่ไม่รู้จัก เลย domain ที่ผิดบางตัวข้าง
// บนแค่ดูธรรมดา ไม่ดูพัง
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

// ยิงบรรทัด "STATUS:<stage>" / "PROGRESS:<0-100>" ที่ run_script executor
// stream แบบ real-time อยู่แล้ว (runScript ใน internal/executor/executor.go
// ตามแนวทางเดียวกับที่ network_diagnostic เคย stream) — DeployProgress
// ด้านล่างจะ parse ค่านี้ออกจาก commandOutputs ส่วนดาวน์โหลดได้ progress
// แบบ byte-accurate จริง (ใช้ read-loop ของ HttpWebRequest เอง เพราะ
// Invoke-WebRequest/WebClient ไม่ให้ live progress จาก headless script)
// ส่วน "installing" จำเป็นต้อง indeterminate เพราะ silent installer ภายนอก
// (ของ Ninite หรือตัวอื่น) ไม่รายงาน progress ของตัวเอง เลยไม่มีตัวเลขที่
// เชื่อถือได้จะโชว์หลังดาวน์โหลดเสร็จ
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
    // -NoNewWindow สำคัญตรงนี้เพราะ stdout/stderr ของ script นี้ถูก redirect
    // อยู่แล้ว (ส่งกลับไป dashboard เพื่อ live progress) — ทดสอบบนเครื่องจริง
    // แล้วว่า Start-Process ที่ไม่มี flag นี้จะค้าง/fail ทันทีที่ agent build
    // นี้เริ่ม stream output ทั้งที่ build เก่าแบบ buffered-output รัน Ninite
    // install ตัวเดียวกันได้ปกติ ถ้าไม่ใส่ -NoNewWindow, path เริ่มโปรเซส
    // default ของ Start-Process จะทำงานต่างออกไปเมื่อ process ที่เรียกไม่มี
    // console จริงของตัวเอง (เป็นจริงทั้งกรณี "output ถูก pipe" และ "รันเป็น
    // Windows service") ซึ่ง agent ตัวนี้เป็นแบบนั้นเสมอ
    // -PassThru กับการเช็ค exit code ตรง ๆ ก็สำคัญ: ถ้าไม่มี script นี้จะ
    // รายงาน failure ได้แค่ตอน PowerShell เอง throw (timeout, parse error)
    // — installer ที่ exit ด้วย code ไม่ใช่ 0 (fail จริง) จะหลุดผ่านไปเป็น
    // "Completed successfully" เพราะไม่มีอะไร crash 3010 ตั้งใจยกเว้นไว้
    // เพราะเป็น convention ของ Windows Installer เองที่แปลว่า "สำเร็จ แต่
    // ต้อง reboot" ไม่ใช่ failure
    `$proc = Start-Process -FilePath $dest -NoNewWindow -Wait -PassThru`,
    `if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "installer exited with code $($proc.ExitCode)" }`,
    `Remove-Item $dest -Force -ErrorAction SilentlyContinue`,
    `Write-Output "STATUS:done"`,
  ].join("\n");
  return { url, script };
}

// จุดเริ่มต้นที่พอใช้ได้ต่อประเภทไฟล์ — silent switch จริงของแต่ละ installer
// ต่างกันไปตาม vendor เลยเป็นแค่ค่าเริ่มต้นให้แก้ ไม่ควรเชื่อทั้งดุ้น $file
// ถูก define โดย buildCustomScript ด้านล่างก่อนบรรทัดนี้จะรัน เช็ค exit code
// จริงก่อนถือว่าสำเร็จ — ดูเหตุผลที่ comment ของ buildNiniteScript
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
    // HTTPS listener ของ agent hub เองใช้ self-signed cert (ดู
    // dist-agent-deploy-global/optifleet-cert.pem) — Go agent pin cert นี้
    // ไว้ตรง ๆ สำหรับ request ของมันเอง แต่ Invoke-WebRequest ธรรมดาใน
    // script นี้ไม่มี trust config แบบนั้น เลย fail ด้วย "Could not
    // establish trust relationship for the SSL/TLS secure channel" กับ
    // trust store default ของ Windows PowerShell 5.1 (ทดสอบบนเครื่องจริง
    // แล้ว) scriptblock แบบ `ServerCertificateValidationCallback = { $true }`
    // ดูเหมือนจะเป็นทางแก้ที่ตรงไปตรงมา แต่จริง ๆ fail คนละแบบ ("There is
    // no Runspace available to run scripts in this thread") — callback
    // ของ TLS handshake รันบน worker thread ที่ไม่มี PowerShell runspace
    // ผูกอยู่เลย scriptblock ของ PS เลยรันตรงนั้นไม่ได้เลย type
    // ICertificatePolicy ที่ compile แล้วไม่มีข้อจำกัดแบบนี้ เลยใช้
    // Add-Type แทนการเขียน callback บรรทัดเดียว — ก็ยืนยันด้วยการเจอ error
    // ด้านบนจริงบนเครื่องจริงมาก่อนแล้ว
    `Add-Type @"\nusing System.Net;\nusing System.Security.Cryptography.X509Certificates;\npublic class TrustAllCertsPolicy : ICertificatePolicy {\n    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {\n        return true;\n    }\n}\n"@`,
    `[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy`,
    // .NET Framework ของ Windows PowerShell 5.1 default เป็น TLS version
    // เก่าที่ agent hub (ขั้นต่ำ TLS 1.2) ปฏิเสธตรง ๆ — ทดสอบบนเครื่องจริง
    // แล้วว่า error คนละแบบกับเรื่อง cert ด้านบน ("An unexpected error
    // occurred on a send" กลาง handshake ไม่ใช่ trust failure) เลยต้องแก้
    // ทั้งสองอย่างคู่กัน แก้แค่อันเดียวไม่พอ
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

  // state ของโหมด Ninite
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customSlugs, setCustomSlugs] = useState("");
  const [niniteBusy, setNiniteBusy] = useState(false);
  const [niniteResult, setNiniteResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [niniteCommandId, setNiniteCommandId] = useState<string | null>(null);

  // state ของโหมด custom installer
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

        {/* ใช้ CSS multi-column ไม่ใช่ grid: แถวของ grid จะปรับความสูงทุก
            cell ให้เท่ากับตัวที่สูงสุดในแถว เลยถ้า category ที่มี 6 แอป
            (Web Browsers) อยู่ข้าง ๆ ตัวที่มี 19 แอป (.NET) จะเหลือช่องว่าง
            ใหญ่ ๆ ใต้ตัวสั้นก่อนแถวถัดไปจะเริ่มได้ ใช้ column แทนจะให้แต่ละ
            category ไหลต่อจากตัวก่อนหน้าใน column เดียวกันเลย แน่นเหมือน
            layout ของ ninite.com เอง */}
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

          {/* ซ่อนปุ่มทันทีที่มีผลลัพธ์ออกมา — message/progress ด้านบนโชว์
              ✓/✗ อยู่แล้ว ปุ่มก็หายไปเลยแทนที่จะค้างเชิญให้กดซ้ำ command
              ที่รันไปแล้ว */}
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
