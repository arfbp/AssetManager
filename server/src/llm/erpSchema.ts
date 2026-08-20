// เป็นคู่กันกับ adminSchema.ts แต่สำหรับฝั่ง Asset Management ERP — เป็น
// โครงสร้างตายตัวตัวที่สามสำหรับคำขอเกี่ยวกับ vendor, purchase order,
// maintenance และการส่งมอบ asset ลงทะเบียนเป็น tool บังคับตัวที่สามคู่กับ
// emit_fleet_command/emit_admin_command (ดู actionParser.ts) เพื่อให้ LLM
// เรียกครั้งเดียวแล้วแยกแยะได้ทั้งสามแบบ โดยโมเดลจะเลือกใช้ tool เดียวต่อการ
// เรียกหนึ่งครั้งเท่านั้น ไม่มีทางเลือกเกินหนึ่ง
//
// ทุก action ประเภทสร้างใหม่ในนี้จะจบด้วยการเปิดฟอร์ม dashboard ที่ผ่านการ
// validate แล้ว พร้อมกรอกค่าที่ดึงมาได้ล่วงหน้า (จุดยืนแบบเดียวกับ "ให้มนุษย์
// กรอกฟอร์มจริงเอง" ของ create_organization/create_user ใน adminSchema.ts)
// — action ประเภท approve/reject/complete/handover ต้องให้มนุษย์ยืนยันชัดเจน
// โดยระบุชื่อ target ที่ resolve แล้ว ไม่มีส่วนไหนในนี้ที่ถูกเชื่อถือว่าเป็นการ
// อนุมัติสิทธิ์ได้ด้วยตัวเอง จุดยืนเดียวกับ doc comment ของ schema.ts
import { z } from "zod";
import type OpenAI from "openai";

export const ERP_ACTIONS = [
  "create_vendor",
  "create_purchase_order",
  "approve_purchase_order",
  "reject_purchase_order",
  "schedule_maintenance",
  "complete_maintenance",
  "handover_asset",
] as const;

// sub-key ทุกตัวใน `fields` เป็น optional (default เป็น "") ด้วยเหตุผลเดียวกับ
// ที่อธิบายไว้ใน adminSchema.ts: tool-schema validator ของ Groq เองจะตอบ 400
// แบบ tool_use_failed ถ้าบังคับให้ `fields` ต้องมีครบทุก key ในขณะที่โมเดลเลือก
// จะไม่ใส่ key ที่ไม่เกี่ยวกับ action ที่มันเลือก จึงไม่มี list `required` บน
// object ของ fields เหมือนกับ JSON schema ของ adminSchema.ts ด้านล่างนี้
export const ErpParsedIntentSchema = z.object({
  action: z.enum(ERP_ACTIONS),
  // ชื่อ vendor, เลข PO หรือ asset tag แล้วแต่ action — เป็นค่าว่างสำหรับ
  // create_vendor/create_purchase_order (ยังไม่มี target เพราะเป็นการสร้าง
  // ของใหม่)
  targetName: z.string().describe("The vendor name, PO number, or asset tag this action applies to. Empty string if not applicable."),
  fields: z
    .object({
      name: z.string().describe("Vendor name, for create_vendor. Empty otherwise.").default(""),
      contactName: z.string().describe("Vendor contact person's name, for create_vendor. Empty if not stated.").default(""),
      email: z.string().describe("Vendor contact email, for create_vendor. Empty if not stated.").default(""),
      phone: z.string().describe("Vendor phone number, for create_vendor. Empty if not stated.").default(""),
      vendorName: z.string().describe("The vendor to order from, for create_purchase_order. Empty otherwise.").default(""),
      itemDescription: z.string().describe("What's being purchased, for create_purchase_order. Empty otherwise.").default(""),
      quantity: z.string().describe("How many, for create_purchase_order. Empty if not stated — defaults to 1.").default(""),
      unitCost: z.string().describe("Price per unit, for create_purchase_order. Empty if not stated.").default(""),
      description: z.string().describe("What maintenance/repair is needed, for schedule_maintenance. Empty otherwise.").default(""),
      scheduledDate: z.string().describe("Date the maintenance is scheduled for (YYYY-MM-DD if determinable), for schedule_maintenance. Empty if not stated.").default(""),
      employeeName: z.string().describe("The employee receiving the asset, for handover_asset. Empty otherwise.").default(""),
      employeeEmail: z.string().describe("The employee's email, for handover_asset. Empty if not stated.").default(""),
      employeeDepartment: z.string().describe("The employee's department, for handover_asset. Empty if not stated.").default(""),
    })
    .default({}),
  reasoning: z.string().describe("One short sentence on how the text maps to this action. For audit/log visibility only — never used to decide execution."),
});
export type ErpParsedIntent = z.infer<typeof ErpParsedIntentSchema>;

export const EMIT_ERP_COMMAND_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "emit_erp_command",
    description:
      "Convert an IT operator's natural-language request into a structured Asset Management ERP command — use this " +
      "instead of emit_fleet_command or emit_admin_command when the request is about a VENDOR/SUPPLIER, a PURCHASE " +
      "ORDER, scheduled/completed MAINTENANCE on an asset, or HANDING OVER an asset to an employee. Extract what " +
      "fields you can with confidence; leave anything uncertain as an empty string rather than guessing — a human " +
      "reviews and completes every creation before anything is created, and confirms every approve/reject/complete/" +
      "handover by name before it happens.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ERP_ACTIONS as unknown as string[],
          description:
            "create_vendor: add a new supplier — 'add a vendor called X', 'we're buying from a new supplier X'. " +
            "create_purchase_order: order something from a vendor — 'order 5 laptops from Dell', 'create a PO for " +
            "10 monitors at $200 each from X'. approve_purchase_order / reject_purchase_order: sign off (or not) " +
            "on a purchase order awaiting approval — 'approve PO-0003', 'reject the purchase order for X'. " +
            "schedule_maintenance: log upcoming service/repair on an asset — 'schedule maintenance for OF-0012 " +
            "next week', 'this laptop needs a repair booked in'. complete_maintenance: mark an asset's scheduled " +
            "maintenance done — 'mark maintenance complete for OF-0012', 'the repair on that laptop is finished'. " +
            "handover_asset: record an asset being given to an employee — 'hand over OF-0005 to John Smith', " +
            "'issue this laptop to Jane in Accounting'.",
        },
        targetName: { type: "string" },
        // ตั้งใจไม่ใส่ list `required` ตรงนี้ — ดู doc comment ของไฟล์นี้เอง และ
        // ตัวอย่างเดียวกันใน adminSchema.ts
        fields: {
          type: "object",
          properties: {
            name: { type: "string" },
            contactName: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            vendorName: { type: "string" },
            itemDescription: { type: "string" },
            quantity: { type: "string" },
            unitCost: { type: "string" },
            description: { type: "string" },
            scheduledDate: { type: "string" },
            employeeName: { type: "string" },
            employeeEmail: { type: "string" },
            employeeDepartment: { type: "string" },
          },
        },
        reasoning: { type: "string" },
      },
      required: ["action", "targetName", "reasoning"],
      additionalProperties: false,
    },
  },
};
