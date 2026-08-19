/**
 * Shape of the Better Auth Drizzle adapter, shared by the runtime instance
 * (`src/lib/auth.ts`) and the schema generator config (`better-auth.config.ts`)
 * so the two can never drift apart — a mismatch would make the generated
 * tables and the tables the adapter queries disagree at runtime.
 *
 * `usePlural` matches the table naming already used by `src/db/schema.ts`
 * (`households`), so the auth tables read as `users` / `sessions` /
 * `accounts` / `verifications` rather than Better Auth's singular default.
 *
 * Deliberately free of `server-only`: `better-auth.config.ts` is loaded by the
 * CLI outside Next.js, where that import throws.
 */
export const AUTH_DRIZZLE_CONFIG = {
  provider: "pg",
  usePlural: true,
} as const;
