// คำสั่งถอนการติดตั้งที่ผ่านการตรวจสอบแล้ว จัดเก็บตามชื่อแอปพลิเคชัน LLM parser
// มีหน้าที่แค่ดึงว่า "แอปไหน" ที่ผู้ควบคุมระบุมา (field `target` ใน schema.ts)
// — ไม่มีทางเขียนคำสั่งถอนการติดตั้งจริงเอง ถ้าแอปไม่มีอยู่ในตารางนี้ คำขอจะถูก
// ปฏิเสธ แทนที่จะให้โมเดล improvise สคริปต์เอง หากต้องเพิ่มแอปใหม่ให้เพิ่ม entry
// (แล้วให้รีวิว) แทนการผ่อนปรนกฎนี้
export interface UninstallTemplate {
  interpreter: "powershell";
  script: string;
}

const TEMPLATES: Record<string, UninstallTemplate> = {
  chrome: uninstallViaWinget("Google.Chrome"),
  "google chrome": uninstallViaWinget("Google.Chrome"),
  firefox: uninstallViaWinget("Mozilla.Firefox"),
  "mozilla firefox": uninstallViaWinget("Mozilla.Firefox"),
  zoom: uninstallViaWinget("Zoom.Zoom"),
  teamviewer: uninstallViaWinget("TeamViewer.TeamViewer"),
  "adobe reader": uninstallViaWinget("Adobe.Acrobat.Reader.64-bit"),
  "adobe acrobat reader": uninstallViaWinget("Adobe.Acrobat.Reader.64-bit"),
  slack: uninstallViaWinget("SlackTechnologies.Slack"),
  "7-zip": uninstallViaWinget("7zip.7zip"),
  vlc: uninstallViaWinget("VideoLAN.VLC"),
};

function uninstallViaWinget(wingetId: string): UninstallTemplate {
  return {
    interpreter: "powershell",
    script: `winget uninstall --id ${wingetId} -e --silent --accept-source-agreements`,
  };
}

export function lookupUninstallTemplate(appName: string): UninstallTemplate | null {
  return TEMPLATES[appName.trim().toLowerCase()] ?? null;
}

export function listSupportedApps(): string[] {
  return [...new Set(Object.keys(TEMPLATES))];
}
