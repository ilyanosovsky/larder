import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// Env loading, with a caveat learned the hard way: drizzle-kit ALSO preloads
// `.env` with its own bundled dotenv BEFORE this config runs, and loadEnvFile
// never overrides variables that are already set. Net effect for drizzle-kit:
// `.env` beats `.env.local` here, and the shell environment beats both. That
// is why `.env` must only ever hold the localhost DATABASE_URL (the prod URL
// stays commented out as PROD_DATABASE_URL — see AGENTS.md). The explicit
// loads below cover the files drizzle-kit doesn't read (.env.local) and keep
// a present-but-unreadable file loud: it throws instead of silently falling
// back to a different database.
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
