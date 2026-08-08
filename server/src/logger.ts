// Structured logging: one operational logger, one append-only audit logger.
// Mirrors the split used on the agent side (agent.log / audit.log) so the two
// halves of the system are consistent to operate.
import pino from "pino";

// exactOptionalPropertyTypes forbids `transport: undefined` — an optional
// property must be entirely absent, not present-with-undefined — so the key
// is included conditionally instead of set to a possibly-undefined value.
const prettyTransport =
  process.env.NODE_ENV === "production" ? {} : { transport: { target: "pino-pretty", options: { colorize: true } } };

export const log = pino({ level: process.env.LOG_LEVEL ?? "info", ...prettyTransport });

export const audit = pino({
  level: "info",
  base: { component: "audit" },
  ...prettyTransport,
});
