// Pattern-based tripwire for destructive / defense-evasion content. This is
// defense in depth, not the primary control — the primary control is that
// run_script is off by default (guardrail.ts + the agent's own double-gate)
// and every other action has code-bounded semantics that don't accept
// arbitrary content in the first place. This scan exists for the one case
// where free-form content reaches the pipeline at all: run_script bodies,
// including ones generated from a vetted uninstall template (cheap insurance
// in case a template is ever edited to something unsafe by mistake).
export interface BlacklistHit {
  reason: string;
  matchedPattern: string;
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  // OS / disk destruction
  { pattern: /\bformat\s+[a-z]:/i, reason: "disk format command" },
  { pattern: /\bdiskpart\b/i, reason: "diskpart (can wipe partitions)" },
  { pattern: /\b(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?\s*($|\s)/i, reason: "recursive delete of a drive root" },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\?\s*($|\s)/i, reason: "recursive delete of a drive root" },
  { pattern: /\brm\s+-rf\s+\/(?!\S)/i, reason: "rm -rf on filesystem root" },
  { pattern: /\brm\s+-rf\s+\/\*/i, reason: "rm -rf on filesystem root" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "filesystem creation (destroys existing data)" },
  { pattern: /\bdd\s+if=\S+\s+of=\/dev\//i, reason: "raw disk write via dd" },

  // Ransomware-precursor patterns: killing recovery options before the fact
  { pattern: /\bvssadmin\s+delete\s+shadows/i, reason: "deletes shadow copies (ransomware precursor)" },
  { pattern: /\bwbadmin\s+delete\s+catalog/i, reason: "deletes backup catalog (ransomware precursor)" },
  { pattern: /\bbcdedit\b.*\brecoveryenabled\s+no/i, reason: "disables Windows recovery" },
  { pattern: /\bcipher\s+\/w\b/i, reason: "secure-wipe free space (anti-forensics / data destruction)" },

  // Security control tampering
  { pattern: /\bSet-MpPreference\b.*-Disable/i, reason: "disables Windows Defender protections" },
  { pattern: /\bStop-Service\b.*Defender/i, reason: "stops Windows Defender service" },
  { pattern: /\bsc(\.exe)?\s+stop\s+WinDefend/i, reason: "stops Windows Defender service" },
  { pattern: /\bnetsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off/i, reason: "disables the firewall" },
  { pattern: /\breg\s+add\b.*DisableAntiSpyware/i, reason: "disables antispyware via registry" },

  // Account / access tampering
  { pattern: /\bnet\s+user\s+\S+\s+\/active:\s*yes/i, reason: "activates a user account (possible backdoor)" },
  { pattern: /\bnet\s+localgroup\s+administrators\s+\S+\s+\/add/i, reason: "adds a user to local administrators" },

  // Anti-forensics
  { pattern: /\bwevtutil\s+cl\b/i, reason: "clears a Windows event log (anti-forensics)" },
  { pattern: /\bClear-EventLog\b/i, reason: "clears a Windows event log (anti-forensics)" },

  // Obfuscation / download-and-execute cradles
  { pattern: /-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{20,}/i, reason: "obfuscated/base64-encoded PowerShell command" },
  {
    pattern: /IEX\s*\(.*(New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)/i,
    reason: "download-and-execute cradle",
  },
  { pattern: /\bcertutil\b.*-urlcache/i, reason: "certutil used as a download tool (LOLBin abuse)" },

  // Fork bomb
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/, reason: "shell fork bomb" },

  // Bypassing the agent's own restart safeguard (confirm + delay)
  { pattern: /\bshutdown\s+\/r\s+\/f\s+\/t\s+0\b/i, reason: "forced immediate restart bypassing normal confirmation" },
];

export function scanForBlacklistedContent(content: string): BlacklistHit | null {
  for (const rule of RULES) {
    if (rule.pattern.test(content)) {
      return { reason: rule.reason, matchedPattern: rule.pattern.source };
    }
  }
  return null;
}
