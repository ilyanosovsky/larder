import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// drizzle-kit does not auto-load env files, so load them here before reading
// process.env. Existence is checked explicitly; a present-but-unreadable file
// must throw rather than silently fall back to a different DATABASE_URL and
// point a migration at the wrong database. loadEnvFile never overrides
// variables that are already set, so .env.local wins over .env, and the shell
// environment wins over both.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Provide it via .env.local, .env, or the shell environment.",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
