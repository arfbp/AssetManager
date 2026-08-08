// Vetted uninstall commands keyed by application name. The LLM parser
// extracts *which* app the operator named (schema.ts's `target` field) —
// it never authors the actual removal command. If an app isn't in this
// table, the request is rejected rather than letting the model improvise
// a script; add an entry (and get it reviewed) instead of relaxing that.
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
