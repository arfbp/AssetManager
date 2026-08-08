// Single shared Postgres pool for the process. Kept as a lazily-set module
// singleton (rather than threaded through every function signature) because
// db/persistence.ts is the only consumer and it's wired once at startup —
// see index.ts.
import pg from "pg";
import { log } from "../logger.js";

let pool: pg.Pool | null = null;

export function initPool(connectionString: string): pg.Pool {
  pool = new pg.Pool({ connectionString });
  // A dropped idle connection must not crash the process — the pool
  // reconnects on the next query. Persistence is a durability nice-to-have,
  // not something live agent handling should ever depend on staying up.
  pool.on("error", (err) => {
    log.error({ err }, "db: idle client error");
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("db: pool not initialized — call initPool() before getPool()");
  }
  return pool;
}
