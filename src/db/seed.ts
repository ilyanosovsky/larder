// Run via `pnpm db:seed` (tsx src/db/seed.ts). Deliberately independent of
// `./index.ts`'s `db()`: that module is guarded by `import "server-only"`,
// which throws when run directly under Node/tsx outside a Next.js
// server-component bundle. This script opens its own connection instead.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Seeds baseline data into a fresh database.
 *
 * Deliberately still a no-op after task 1.2: the default 7 departments are
 * per-household data, not global rows, so they are inserted by
 * `household.create` (and backed into existing households by migration
 * `0003_true_tigra`) rather than by this script — see
 * `src/server/catalog/default-categories.ts`. The reference product catalog
 * (`src/server/catalog/reference-products.ts`) is static in-code data for
 * the task 1.3 autocomplete, never rows in the database, so there is
 * nothing for a seed script to write for it either.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so main() can still call seed(db); nothing here needs it, see above
export async function seed(db: Database): Promise<void> {
  // Nothing to seed: see the comment above.
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  try {
    await seed(db);
    console.log("nothing to seed yet");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
