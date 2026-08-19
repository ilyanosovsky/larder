// drizzle-kit does not auto-load env files, so load them here before reading
// process.env. Either file may be absent (e.g. in CI), hence the try/catch.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present — fall through to .env
}
try {
  process.loadEnvFile(".env");
} catch {
  // .env not present either — DATABASE_URL must come from the shell env
}

import { defineConfig } from "drizzle-kit";

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
