import "server-only";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

let cached: Database | undefined;

/**
 * Lazily-created singleton Drizzle client over a postgres.js connection pool.
 *
 * Creation is intentionally lazy — it happens on first call, not on module
 * import — so importing this module never connects or throws. `pnpm build`
 * runs in CI with no environment variables set at all, and must still
 * succeed; only code paths that actually call `db()` at runtime need
 * `DATABASE_URL` to be present.
 *
 * This pooled connection is for regular queries only. Postgres LISTEN/NOTIFY
 * (task 2.2, VISION §6.3) needs its own dedicated, non-pooled `postgres.js`
 * connection via `sql.listen()` — do not reuse this client for that.
 */
export function db(): Database {
  if (!cached) {
    const client = postgres(env().DATABASE_URL);
    cached = drizzle(client, { schema });
  }
  return cached;
}
