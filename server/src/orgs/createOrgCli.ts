// CLI bootstrap for a new organization — `npm run org:create -- <name> <subdomain>`.
// Prints the generated agent credentials once (never retrievable again
// through any endpoint) — same "write it down now" treatment as any other
// freshly generated secret. The dashboard's own "Create organization" menu
// (routes.ts's POST /orgs, admin-only within the platform org — see
// orgsStore.ts's PLATFORM_ORG_ID) is the normal path; this exists for the
// very first organization (before any dashboard session can exist to create
// one from) and as a scriptable/ops alternative.
//
// Known gap, deliberately not fixed here: this process has no way to signal
// an already-running server to reload its in-memory OrgCredentialCache (only
// the HTTP route can call credentials.reload() on the live instance — see
// orgCredentials.ts). Used against a live server, an org created this way
// silently doesn't work until a restart. The printed reminder below is the
// mitigation; prefer the dashboard flow whenever the server is already up.
import "dotenv/config";
import { initPool } from "../db/pool.js";
import { createOrganization, isValidSubdomain, DuplicateSubdomainError } from "./orgsStore.js";

async function main(): Promise<void> {
  const [, , name, subdomain] = process.argv;
  if (!name || !subdomain) {
    console.error("usage: npm run org:create -- <name> <subdomain>");
    process.exitCode = 1;
    return;
  }
  const normalizedSubdomain = subdomain.trim().toLowerCase();
  if (!isValidSubdomain(normalizedSubdomain)) {
    console.error(`invalid subdomain "${subdomain}" — lowercase letters, digits, hyphens only, can't start/end with a hyphen`);
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.OPTIFLEET_DATABASE_URL;
  if (!databaseUrl) {
    console.error("OPTIFLEET_DATABASE_URL must be set (see server/.env) — run `npm run db:migrate` first if you haven't.");
    process.exitCode = 1;
    return;
  }

  const pool = initPool(databaseUrl);
  try {
    const created = await createOrganization(pool, name, normalizedSubdomain);
    console.log(`organization "${created.org.name}" created (id ${created.org.id}, subdomain "${created.org.subdomain}").`);
    console.log("");
    console.log("Agent credentials — save these now, they are not shown again:");
    console.log(`  OPTIFLEET_AUTH_TOKEN=${created.agentAuthToken}`);
    console.log(`  OPTIFLEET_HMAC_SECRET=${created.agentHmacSecret}`);
    console.log("");
    console.log(`Next: npm run user:create -- <username> <password> admin ${created.org.subdomain}`);
    console.log("");
    console.log("*** IMPORTANT: this CLI runs as its own process and cannot reach an");
    console.log("*** already-running server's in-memory credential cache. If the server");
    console.log("*** is currently running, this org's agents/CORS will silently NOT work");
    console.log("*** until you run: systemctl restart optifleet-server (or your");
    console.log("*** deployment's equivalent). The dashboard's own \"Create organization\"");
    console.log("*** flow does not have this problem — prefer it when the server is live.");
  } catch (err) {
    if (err instanceof DuplicateSubdomainError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
