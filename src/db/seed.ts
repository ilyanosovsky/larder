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
 * TODO(1.2): insert the default category/product catalog once it exists.
 * Task 0.2 only wires up the migration pipeline and the `pnpm db:seed`
 * entry point, so this is intentionally a no-op for now.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- db will be used once the task-1.2 catalog seed lands
export async function seed(db: Database): Promise<void> {
  // Nothing to seed yet.
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
