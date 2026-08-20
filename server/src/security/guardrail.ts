// จุดตรวจจุดเดียวที่ natural-language command ทุกตัวที่ parse มาแล้วต้องผ่าน
// ก่อนจะกลายเป็น signed CommandPayload ที่ส่งไปยัง agent ตรงนี้ไม่มีอะไรเชื่อ
// ผลลัพธ์ของ LLM เป็น authorization decision เลย — การ resolve scope คือการ
// lookup config ในเครื่อง (deviceGroups.ts) semantics ของ action ถูก
// re-derive จาก switch ที่ตายตัว (ไม่ได้ copy มาจาก model) และเนื้อหาที่จะ
// ไปถึง agent ในรูปแบบข้อความที่รันได้จะถูก blacklist-scan เสมอ แม้จะมาจาก
// template ที่ตรวจสอบไว้ล่วงหน้าแล้วก็ตาม
import { audit } from "../logger.js";
import type { DeviceGroups } from "../groups/deviceGroups.js";
import { lookupUninstallTemplate } from "../llm/uninstallTemplates.js";
import type { ParsedIntent } from "../llm/schema.js";
import { scanForBlacklistedContent } from "./blacklist.js";
import type { CommandAction } from "../protocol.js";

export interface ResolvedCommand {
  action: CommandAction;
  params: Record<string, string>;
}

export type GuardrailVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "needs_confirmation"; resolved: ResolvedCommand; targets: string[]; reason: string }
  | { verdict: "allowed"; resolved: ResolvedCommand; targets: string[] };

export interface GuardrailContext {
  orgId: string;
  deviceGroups: DeviceGroups;
  /** สะท้อนตาม gate OPTIFLEET_ENABLE_RUN_SCRIPT ของฝั่ง agent เอง — เซิร์ฟเวอร์เก็บสำเนาการตัดสินใจนี้ไว้อีกชุดแยกต่างหาก */
  enableRunScriptDispatch: boolean;
  /** จำนวน target ที่ resolve ได้ถ้าถึงหรือเกินค่านี้ บังคับให้ต้องยืนยันจากมนุษย์สำหรับ action ที่เป็น destructive ไม่ว่าสัญญาณ confirm ของ LLM จะเป็นอย่างไร */
  massActionThreshold: number;
}

function blocked(reason: string): GuardrailVerdict {
  return { verdict: "blocked", reason };
}

export function evaluateParsedIntent(parsed: ParsedIntent, ctx: GuardrailContext): GuardrailVerdict {
  const auditBase = { action: parsed.action, target: parsed.target, scope: parsed.scope, llmReasoning: parsed.reasoning };

  if (parsed.action === "unsupported") {
    audit.warn({ ...auditBase, verdict: "blocked" }, "guardrail: request did not map to a supported action");
    return blocked("Could not confidently map this request to a supported fleet action.");
  }

  const targets = ctx.deviceGroups.resolve(ctx.orgId, parsed.scope);
  if (targets.length === 0) {
    audit.warn({ ...auditBase, verdict: "blocked" }, "guardrail: unknown scope");
    return blocked(
      `Unknown device/group scope "${parsed.scope}". Known scopes: ${ctx.deviceGroups.listScopes(ctx.orgId).join(", ")}`,
    );
  }

  const resolution = resolveAction(parsed, ctx);
  if (resolution.verdict === "blocked") {
    audit.warn({ ...auditBase, verdict: "blocked", reason: resolution.reason }, "guardrail: action resolution blocked");
    return resolution;
  }
  const resolved = resolution.resolved;

  const massAction = targets.length >= ctx.massActionThreshold;
  const isDestructiveTier =
    parsed.action === "restart_host" || parsed.action === "shutdown_host" || parsed.action === "uninstall_software";
  const isKillProcess = parsed.action === "kill_process";

  // restart_host / shutdown_host / uninstall_software: ต้องการการยืนยันจาก
  // มนุษย์เสมอ ไม่มีข้อยกเว้น — parsed.confirm เพียงอย่างเดียวไม่เคยพอที่จะ
  // ข้ามขั้นตอนนี้ได้ ไม่ว่า request จะเขียนมาอย่างไรหรือ model จะมั่นใจแค่ไหน
  // เดิมทีระบบนี้เคยยอมให้ข้ามการยืนยันได้เมื่อ model รายงาน confirm=true
  // สำหรับ target เดียว โดยคิดว่าถ้อยคำของ operator ที่ชัดเจนพอ ("restart it
  // now, confirmed") ไม่ควรต้องคลิกซ้ำอีกครั้งโดยไม่จำเป็น แต่ในทางปฏิบัติ
  // model ไม่น่าเชื่อถือพอสำหรับเรื่องนี้: ยืนยันจากของจริงแล้วว่าข้อความ
  // เปล่าๆ ที่ไม่ชัดเจนแบบเดียวกันเป๊ะ ("restart" เฉยๆ ไม่มีอะไรอื่น) ได้
  // parsed.confirm=false สำหรับอุปกรณ์หนึ่ง และ parsed.confirm=true สำหรับ
  // อีกอุปกรณ์ในการเรียกติดต่อกัน และตัวหลัง dispatch การ reboot จริงโดยไม่
  // มีมนุษย์คนไหนยืนยันอะไรเลย การ reboot จะปิดทุกโปรแกรมที่กำลังรันอยู่บน
  // เครื่องจริง — ค่าใช้จ่ายของการคลิกเพิ่มอีกครั้งสำหรับกรณีหายากที่
  // operator ตั้งใจข้ามการยืนยันจริงๆ นั้นถูกกว่าค่าใช้จ่ายของการเชื่อ field
  // นี้มาก kill_process: เดิมพันต่ำกว่า (กู้คืนได้ จำกัดแค่ process เดียว) —
  // จะยกระดับไปเป็นต้องยืนยันก็ต่อเมื่อเป็น mass action ข้ามหลายอุปกรณ์
  // เท่านั้น clean_temp: ไม่ต้องการการยืนยันเลย เพราะถูกจำกัดขอบเขตด้วย
  // directory allowlist ที่ฝั่ง agent อยู่แล้วอย่างเข้มงวด
  let needsConfirmation = false;
  const reasons: string[] = [];
  if (isDestructiveTier) {
    needsConfirmation = true;
    reasons.push("destructive action — always requires explicit human confirmation before dispatch");
    if (targets.length > 1) reasons.push(`targets ${targets.length} devices`);
  } else if (isKillProcess && massAction) {
    needsConfirmation = true;
    reasons.push(`targets ${targets.length} devices`);
  }

  if (needsConfirmation) {
    audit.warn(
      { ...auditBase, verdict: "needs_confirmation", targets, resolved },
      "guardrail: command requires human confirmation before dispatch",
    );
    return { verdict: "needs_confirmation", resolved, targets, reason: reasons.join("; ") };
  }

  audit.info({ ...auditBase, verdict: "allowed", targets, resolved }, "guardrail: command allowed");
  return { verdict: "allowed", resolved, targets };
}

function resolveAction(
  parsed: ParsedIntent,
  ctx: GuardrailContext,
): { verdict: "resolved"; resolved: ResolvedCommand } | { verdict: "blocked"; reason: string } {
  const target = parsed.target.trim();

  switch (parsed.action) {
    case "kill_process": {
      if (!target) return { verdict: "blocked", reason: "kill_process requires a process name or PID." };
      const params = /^\d+$/.test(target) ? { pid: target } : { name: target };
      return { verdict: "resolved", resolved: { action: "kill_process", params } };
    }

    case "clean_temp": {
      const params = target ? { dir: target } : {};
      return { verdict: "resolved", resolved: { action: "clean_temp", params } };
    }

    case "restart_host": {
      // เป็นการเช็คแยกอิสระ ไม่ใช่แค่ prompt-engineering: restart_host reboot
      // ทั้งเครื่อง ปิดทุกโปรแกรมที่กำลังรันอยู่ ไม่ใช่แค่โปรแกรมเดียว target
      // ที่ไม่ว่างเปล่าตรงนี้แปลว่า model ดึงบางอย่างมาให้ action นอกเหนือไป
      // จากตัวอุปกรณ์เอง — เกือบทุกครั้งเป็นชื่อโปรแกรมเจาะจงจาก request แบบ
      // "restart <app>" ซึ่งจริงๆ เป็น kill_process request ที่ถูกจัด
      // ประเภทผิดเป็น reboot เต็มรูปแบบ เคยเกิดขึ้นจริงมาแล้ว (request ให้
      // restart แอปเดียวกลับ reboot ทั้งเครื่องแทน) จึงต้อง block ไว้เลย
      // ไม่เชื่อ ไม่ว่า reasoning ของ model เองจะว่าอย่างไรก็ตาม
      if (target) {
        return {
          verdict: "blocked",
          reason:
            `restart_host reboots the entire device, but this request named "${target}" as the thing to restart — ` +
            `that reads as a specific program, not the device itself. To restart/close that program, phrase it as ` +
            `"kill ${target}" or "close ${target}" instead. To actually reboot the whole machine, phrase the ` +
            `request without naming a program.`,
        };
      }
      return { verdict: "resolved", resolved: { action: "restart_host", params: { confirm: "true" } } };
    }

    case "shutdown_host": {
      // เช็คแยกอิสระแบบเดียวกับ restart_host และด้วยเหตุผลเดียวกัน:
      // shutdown_host ปิดเครื่องทั้งเครื่อง (และปล่อยให้ปิดค้างไว้ ต่างจาก
      // restart_host) — target ที่ระบุตรงนี้เกือบทุกครั้งแปลว่า request ปิด
      // โปรแกรม ("shut down Chrome") ถูกจัดประเภทผิดเป็นการปิดเครื่องเต็ม
      // รูปแบบ จึงต้อง block ไว้เลยไม่เชื่อ
      if (target) {
        return {
          verdict: "blocked",
          reason:
            `shutdown_host powers off the entire device, but this request named "${target}" as the thing to shut down — ` +
            `that reads as a specific program, not the device itself. To close that program, phrase it as ` +
            `"kill ${target}" or "close ${target}" instead. To actually power off the whole machine, phrase the ` +
            `request without naming a program.`,
        };
      }
      return { verdict: "resolved", resolved: { action: "shutdown_host", params: { confirm: "true" } } };
    }

    case "run_script": {
      // Model ไม่เคยเขียนเนื้อหา run_script เองภายใต้ schema นี้ — ดู
      // schema.ts, target/scope เป็นแค่ identifier ธรรมดา ไม่ใช่ตัว script
      // flow ที่ต้องการ dispatch script ที่ admin เขียนเองจริงๆ ต้องมี
      // endpoint แยกที่ชัดเจน ให้มนุษย์เป็นคนใส่และตรวจ script body เอง
      // ไม่ใช่สิ่งที่ infer มาจาก free text เด็ดขาด
      return {
        verdict: "blocked",
        reason:
          "run_script cannot be dispatched from a natural-language request. Its content must be supplied " +
          "explicitly through a reviewed script-submission flow, not inferred by the parser.",
      };
    }

    case "uninstall_software": {
      if (!ctx.enableRunScriptDispatch) {
        return {
          verdict: "blocked",
          reason: "Uninstall actions require run_script dispatch to be enabled on this server (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH).",
        };
      }
      const template = lookupUninstallTemplate(target);
      if (!template) {
        return {
          verdict: "blocked",
          reason: `No vetted uninstall template for "${target}". An administrator must add one to llm/uninstallTemplates.ts after review.`,
        };
      }
      const hit = scanForBlacklistedContent(template.script);
      if (hit) {
        // Template ที่ตรวจสอบแล้วแต่ดันไปตรงกับ blacklist แปลว่า template
        // ถูกแก้ไข หรือเขียนผิดพลาด — นี่คือ internal integrity failure ไม่ใช่
        // ผลลัพธ์ "request ถูกปฏิเสธ" แบบปกติ จึง log ที่ระดับ error แยกจาก
        // path การ block request ตามปกติ
        audit.error({ target, hit }, "guardrail: vetted uninstall template matched the blacklist scan — treat as compromised");
        return { verdict: "blocked", reason: "Internal safety check failed for this uninstall template — contact an administrator." };
      }
      return {
        verdict: "resolved",
        resolved: {
          action: "run_script",
          params: { interpreter: template.interpreter, script: template.script, confirm: "true" },
        },
      };
    }

    case "ping":
    case "tracert":
    case "nslookup": {
      if (!target) {
        return { verdict: "blocked", reason: `${parsed.action} requires a target hostname or IP address.` };
      }
      return {
        verdict: "resolved",
        resolved: { action: "network_diagnostic", params: { tool: parsed.action, target } },
      };
    }

    case "netstat": {
      return {
        verdict: "resolved",
        resolved: { action: "network_diagnostic", params: { tool: "netstat", target: "" } },
      };
    }

    case "unsupported": {
      // ในทางปฏิบัติ unreachable — evaluateParsedIntent return ไปแล้วก่อนจะ
      // เรียก resolveAction สำหรับ case นี้ จัดการไว้ตรงนี้แค่เพื่อให้
      // switch ยังคง type แบบ exhaustive เทียบกับ ParsedIntent.action
      return { verdict: "blocked", reason: "unsupported action" };
    }

    case "query_info": {
      // ในทางปฏิบัติ unreachable — routes.ts ดัก query_info ไว้ก่อนที่จะ
      // เรียก evaluateParsedIntent เลย (ดู doc comment ของ PARSEABLE_ACTIONS
      // ใน schema.ts) จัดการไว้ตรงนี้แค่เพื่อ typing แบบ exhaustive ถ้ามัน
      // เกิดขึ้นจริง แปลว่า short-circuit นั้นพังไปแล้ว จึง fail closed ด้วย
      // เหตุผลที่ชัดเจน แทนที่จะ resolve ไปเป็น no-op dispatch แบบเงียบๆ
      return { verdict: "blocked", reason: "query_info must be answered before reaching the guardrail, never dispatched" };
    }

    default: {
      const exhaustive: never = parsed.action;
      return { verdict: "blocked", reason: `unhandled action: ${exhaustive}` };
    }
  }
}
