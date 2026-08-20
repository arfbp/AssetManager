// เป็นคู่กันกับ ParsedIntent ใน schema.ts แต่สำหรับคำสั่งด้าน admin — เป็น
// โครงสร้างตายตัวแยกต่างหากสำหรับคำขอเกี่ยวกับ organization/user แทนที่จะเป็น
// device ลงทะเบียนเป็น tool บังคับตัวที่สองคู่กับ emit_fleet_command
// (ดู actionParser.ts) เพื่อให้ LLM เรียกครั้งเดียวแล้วแยกแยะได้ทั้งสองแบบ
// โดยโมเดลจะเลือกใช้ tool เดียวต่อการเรียกหนึ่งครั้งเท่านั้น ไม่มีทางเลือกทั้งคู่
//
// ทุก admin action ที่ resolve ออกมาจะจบด้วยการเปิดฟอร์ม dashboard ที่ผ่านการ
// validate แล้ว พร้อมกรอกค่าที่ดึงมาได้ล่วงหน้า (กรณีสร้างใหม่) หรือไม่ก็ต้องให้
// มนุษย์ยืนยันชัดเจนโดยระบุชื่อ target ที่ resolve แล้ว (กรณีอื่นทั้งหมด) —
// ดู security/adminGuardrail.ts ไม่มีส่วนไหนในนี้ที่ถูกเชื่อถือว่าเป็นการอนุมัติ
// สิทธิ์ได้ด้วยตัวเอง จุดยืนเดียวกับ doc comment ของ schema.ts
import { z } from "zod";
import type OpenAI from "openai";

export const ADMIN_ACTIONS = [
  "create_organization",
  "suspend_organization",
  "reactivate_organization",
  "delete_organization",
  "create_user",
  "delete_user",
  "suspend_user",
  "reactivate_user",
  "generate_installer",
] as const;

// sub-key ทุกตัวใน `fields` เป็น optional (default เป็น "") — ทดสอบจริงแล้วพบว่า
// tool-schema validator ของ Groq เอง (ซึ่งทำงานก่อนที่ zod re-validation จะเห็น
// JSON ด้วยซ้ำ) จะปฏิเสธ call ทั้งก้อนทันทีถ้าบังคับให้ `fields` ต้องมีครบทั้ง 8
// key ในขณะที่โมเดลเลือกจะไม่ใส่ key ที่ไม่เกี่ยวกับ action ที่มันเลือก (เช่น ส่ง
// `"fields": {}` มาสำหรับ suspend_organization) ซึ่งพฤติกรรมนี้ทำให้เกิด 400
// แบบ tool_use_failed ซ้ำ ๆ เฉพาะกับ action ที่ไม่ใช่การสร้างใหม่ ไม่มีทางไปถึง
// evaluateAdminIntent เลย JSON schema ด้านล่างจึงตั้งไว้แบบเดียวกัน (ไม่มี list
// `required` บน object ของ fields) ด้วยเหตุผลเดียวกัน
export const AdminParsedIntentSchema = z.object({
  action: z.enum(ADMIN_ACTIONS),
  // ชื่อ org หรือ username ที่ action นี้ใช้กับ — เป็นค่าว่างสำหรับ action
  // สร้างใหม่สองตัว (ยังไม่มี target) และสำหรับ generate_installer เมื่อผู้เรียก
  // หมายถึง org ของตัวเอง
  targetName: z.string().describe("The organization name or username this action applies to. Empty string if not applicable."),
  fields: z
    .object({
      name: z.string().describe("Organization name, for create_organization. Empty otherwise.").default(""),
      subdomain: z
        .string()
        .describe("Organization subdomain, for create_organization. Empty if not stated — a reasonable one will be derived from the name.")
        .default(""),
      adminUsername: z.string().describe("The new organization's first admin username, for create_organization. Empty otherwise.").default(""),
      adminEmail: z.string().describe("The new organization's first admin email, for create_organization. Empty if not stated.").default(""),
      username: z.string().describe("New username, for create_user. Empty otherwise.").default(""),
      role: z.string().describe("Role for create_user: 'admin', 'it_support', or 'viewer'. Empty if not stated.").default(""),
      firstName: z.string().describe("First name, for create_user. Empty if not stated.").default(""),
      lastName: z.string().describe("Last name, for create_user. Empty if not stated.").default(""),
    })
    .default({}),
  reasoning: z.string().describe("One short sentence on how the text maps to this action. For audit/log visibility only — never used to decide execution."),
});
export type AdminParsedIntent = z.infer<typeof AdminParsedIntentSchema>;

export const EMIT_ADMIN_COMMAND_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "emit_admin_command",
    description:
      "Convert an IT operator's natural-language request into a structured organization/user administration " +
      "command — use this instead of emit_fleet_command when the request is about creating, suspending, " +
      "reactivating, or deleting an ORGANIZATION or a USER ACCOUNT, or about getting an agent installer, " +
      "rather than about a specific device. Extract what fields you can with confidence; leave anything " +
      "uncertain as an empty string rather than guessing — a human reviews and completes every creation " +
      "before anything is created, and confirms every suspend/reactivate/delete by name before it happens.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ADMIN_ACTIONS as unknown as string[],
          description:
            "create_organization: set up a brand-new customer organization — 'create an org called X', " +
            "'sign up a new customer named X'. suspend_organization: block an existing organization's logins " +
            "and agent connections — 'suspend org X', 'disable customer X'. reactivate_organization: undo a " +
            "suspend. delete_organization: permanently remove an organization and everything in it — 'delete " +
            "org X', 'remove customer X for good'. create_user: add a new user account within an organization " +
            "— 'create a user named X', 'add X as it_support'. delete_user: remove a user account. " +
            "suspend_user / reactivate_user: block or restore one user's ability to log in, without deleting " +
            "their account — 'suspend user X', 'lock out X'. generate_installer: the operator wants a " +
            "downloadable agent installer for a machine — 'get me an installer', 'I need to install the agent " +
            "on a new machine', 'download the agent for this org'.",
        },
        targetName: { type: "string" },
        // ตั้งใจไม่ใส่ list `required` ตรงนี้ (ต่างจาก object อื่น ๆ ทุกตัวใน tool
        // schema ของโค้ดนี้) — tool-call validator ของ Groq เองทำงานก่อนที่จะถึง
        // AdminParsedIntentSchema.parse() และการปฏิเสธทั้ง call เพราะขาด field
        // ที่ไม่เกี่ยวกับ action ที่เลือกจริง ๆ (เช่น `fields: {}` สำหรับ
        // suspend_organization) ทดสอบจริงแล้วพบว่าทำให้ admin action ที่ไม่ใช่
        // การสร้างใหม่ล้มเหลวทุกครั้ง `.default("")` ของแต่ละ field ใน
        // AdminParsedIntentSchema จะช่วย normalize object บางส่วนที่ส่งมาเอง
        fields: {
          type: "object",
          properties: {
            name: { type: "string" },
            subdomain: { type: "string" },
            adminUsername: { type: "string" },
            adminEmail: { type: "string" },
            username: { type: "string" },
            role: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
          },
        },
        reasoning: { type: "string" },
      },
      required: ["action", "targetName", "reasoning"],
      additionalProperties: false,
    },
  },
};
