// The admin-command counterpart to schema.ts's ParsedIntent — a separate,
// equally fixed shape for requests about organizations/users rather than
// devices. Registered as a second forced tool alongside emit_fleet_command
// (see actionParser.ts) so one LLM call can recognize either kind of
// request; the model picks exactly one tool per call, never both.
//
// Every admin action this resolves to either opens an already-validated
// dashboard form pre-filled with best-effort extracted values (creation)
// or requires an explicit human confirmation naming the resolved target
// (everything else) — see security/adminGuardrail.ts. Nothing here is
// trusted as an authorization decision by itself, same posture as
// schema.ts's own doc comment.
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

// Every `fields` sub-key is optional here (defaulted to "") — verified
// live that Groq's own tool-schema validator (which runs before this zod
// re-validation even sees the JSON) rejects the call outright if `fields`
// is required to carry all 8 keys and the model, reasonably, omits the
// ones that don't apply to whichever action it picked (e.g. emits
// `"fields": {}` for suspend_organization) — this consistently 400'd as
// tool_use_failed for exactly the non-creation actions, never reaching
// evaluateAdminIntent at all. The JSON schema below matches (no `required`
// list on the fields object) for the same reason.
export const AdminParsedIntentSchema = z.object({
  action: z.enum(ADMIN_ACTIONS),
  // The org name or username the action applies to — empty for the two
  // creation actions (nothing to target yet) and for generate_installer
  // when the caller means their own org.
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
        // Deliberately no `required` list here (unlike every other object
        // in this codebase's tool schemas) — Groq's own tool-call validator
        // runs before this ever reaches AdminParsedIntentSchema.parse(),
        // and rejecting the whole call for omitting fields that genuinely
        // don't apply to the chosen action (e.g. `fields: {}` for
        // suspend_organization) was verified live to make every non-
        // creation admin action fail outright. AdminParsedIntentSchema's
        // own per-field `.default("")` normalizes whatever partial object
        // does arrive.
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
