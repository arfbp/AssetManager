// Tripwire แบบอิงรูปแบบ (pattern) สำหรับเนื้อหาที่ทำลายล้างหรือหลบเลี่ยงระบบ
// ป้องกัน นี่คือ defense in depth ไม่ใช่ตัวควบคุมหลัก — ตัวควบคุมหลักคือ
// run_script ปิดไว้เป็นค่า default (guardrail.ts + double-gate ของฝั่ง agent
// เอง) และทุก action อื่นมี semantics ที่ผูกไว้กับโค้ดตายตัว ไม่รับเนื้อหา
// อิสระตั้งแต่แรกอยู่แล้ว การสแกนนี้มีไว้สำหรับกรณีเดียวที่เนื้อหาอิสระ
// เข้าถึง pipeline ได้จริง: เนื้อหาของ run_script รวมถึงที่สร้างจาก template
// uninstall ที่ตรวจสอบแล้ว (เป็นประกันราคาถูก เผื่อ template ถูกแก้ไขจน
// กลายเป็นไม่ปลอดภัยโดยไม่ได้ตั้งใจสักวัน)
export interface BlacklistHit {
  reason: string;
  matchedPattern: string;
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  // ทำลาย OS / ดิสก์
  { pattern: /\bformat\s+[a-z]:/i, reason: "disk format command" },
  { pattern: /\bdiskpart\b/i, reason: "diskpart (can wipe partitions)" },
  { pattern: /\b(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?\s*($|\s)/i, reason: "recursive delete of a drive root" },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\?\s*($|\s)/i, reason: "recursive delete of a drive root" },
  { pattern: /\brm\s+-rf\s+\/(?!\S)/i, reason: "rm -rf on filesystem root" },
  { pattern: /\brm\s+-rf\s+\/\*/i, reason: "rm -rf on filesystem root" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "filesystem creation (destroys existing data)" },
  { pattern: /\bdd\s+if=\S+\s+of=\/dev\//i, reason: "raw disk write via dd" },

  // รูปแบบที่มักมาก่อน ransomware: ตัดทางกู้คืนก่อนลงมือ
  { pattern: /\bvssadmin\s+delete\s+shadows/i, reason: "deletes shadow copies (ransomware precursor)" },
  { pattern: /\bwbadmin\s+delete\s+catalog/i, reason: "deletes backup catalog (ransomware precursor)" },
  { pattern: /\bbcdedit\b.*\brecoveryenabled\s+no/i, reason: "disables Windows recovery" },
  { pattern: /\bcipher\s+\/w\b/i, reason: "secure-wipe free space (anti-forensics / data destruction)" },

  // การแทรกแซงระบบควบคุมความปลอดภัย
  { pattern: /\bSet-MpPreference\b.*-Disable/i, reason: "disables Windows Defender protections" },
  { pattern: /\bStop-Service\b.*Defender/i, reason: "stops Windows Defender service" },
  { pattern: /\bsc(\.exe)?\s+stop\s+WinDefend/i, reason: "stops Windows Defender service" },
  { pattern: /\bnetsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off/i, reason: "disables the firewall" },
  { pattern: /\breg\s+add\b.*DisableAntiSpyware/i, reason: "disables antispyware via registry" },

  // การแทรกแซงบัญชี / สิทธิ์การเข้าถึง
  { pattern: /\bnet\s+user\s+\S+\s+\/active:\s*yes/i, reason: "activates a user account (possible backdoor)" },
  { pattern: /\bnet\s+localgroup\s+administrators\s+\S+\s+\/add/i, reason: "adds a user to local administrators" },

  // การลบร่องรอย (anti-forensics)
  { pattern: /\bwevtutil\s+cl\b/i, reason: "clears a Windows event log (anti-forensics)" },
  { pattern: /\bClear-EventLog\b/i, reason: "clears a Windows event log (anti-forensics)" },

  // การอำพราง / คำสั่งดาวน์โหลดแล้วรันทันที
  { pattern: /-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{20,}/i, reason: "obfuscated/base64-encoded PowerShell command" },
  {
    pattern: /IEX\s*\(.*(New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)/i,
    reason: "download-and-execute cradle",
  },
  { pattern: /\bcertutil\b.*-urlcache/i, reason: "certutil used as a download tool (LOLBin abuse)" },

  // Fork bomb
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/, reason: "shell fork bomb" },

  // การหลบเลี่ยงกลไกป้องกันการ restart ของ agent เอง (confirm + delay)
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
