// Signs commands with HMAC-SHA256 over a netstring-encoded canonical form —
// this MUST byte-for-byte match internal/transport/protocol.go's
// CommandPayload.CanonicalString() on the Go agent, or every command will be
// rejected as a signature mismatch.
//
// Why netstrings ("<byte-length>:<bytes>") instead of JSON: a JSON-based
// canonical form has to reproduce Go's exact json.Marshal behavior byte for
// byte — including its default HTML-escaping of `<`, `>`, `&` — to get an
// identical signature across languages. That's a real footgun for a field
// like run_script's `script` param, which can contain arbitrary shell/
// PowerShell text with any of those characters. A length-prefixed encoding
// needs no escaping at all: every token declares its own byte length, so
// concatenation is unambiguous regardless of what the string contains.
import { createHmac } from "node:crypto";
import type { CommandAction } from "../protocol.js";

function netstring(s: string): string {
  const byteLength = Buffer.byteLength(s, "utf8");
  return `${byteLength}:${s}`;
}

export interface UnsignedCommand {
  id: string;
  action: CommandAction;
  params: Record<string, string>;
  issuedAtUnix: number;
}

export function canonicalString(cmd: UnsignedCommand): string {
  const sortedKeys = Object.keys(cmd.params).sort();
  let paramsBlob = "";
  for (const key of sortedKeys) {
    paramsBlob += netstring(key) + netstring(cmd.params[key] ?? "");
  }

  return (
    netstring(cmd.id) +
    netstring(cmd.action) +
    netstring(String(cmd.issuedAtUnix)) +
    netstring(paramsBlob)
  );
}

export function signCommand(cmd: UnsignedCommand, hmacSecret: string): string {
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonicalString(cmd), "utf8");
  return mac.digest("hex");
}

// Mirrors internal/transport/protocol.go's SelfUpdatePayload.canonicalString
// — MUST stay byte-for-byte in sync with that Go implementation, same as
// canonicalString above. Deliberately a separate function rather than
// reusing UnsignedCommand's shape: a self-update instruction has no
// params/action fields, and keeping it structurally distinct is one more
// small reminder that this signs a different, more narrowly-trusted kind of
// message (see protocol.ts's SelfUpdatePayload doc comment).
export interface UnsignedSelfUpdate {
  version: string;
  url: string;
  sha256: string;
  issuedAtUnix: number;
}

export function signSelfUpdate(payload: UnsignedSelfUpdate, hmacSecret: string): string {
  const canonical =
    netstring(payload.version) + netstring(payload.url) + netstring(payload.sha256) + netstring(String(payload.issuedAtUnix));
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonical, "utf8");
  return mac.digest("hex");
}

// Mirrors internal/transport/protocol.go's ConfigUpdatePayload.canonicalString
// — MUST stay byte-for-byte in sync with that Go implementation.
export interface UnsignedConfigUpdate {
  configYaml: string;
  configSha256: string;
  enableRunScript: boolean;
  issuedAtUnix: number;
}

export function signConfigUpdate(payload: UnsignedConfigUpdate, hmacSecret: string): string {
  const canonical =
    netstring(payload.configYaml) +
    netstring(payload.configSha256) +
    netstring(String(payload.enableRunScript)) +
    netstring(String(payload.issuedAtUnix));
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonical, "utf8");
  return mac.digest("hex");
}
