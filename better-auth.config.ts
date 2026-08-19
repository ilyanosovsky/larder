import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

// Relative, not "@/..." — the generator loads this file outside Next.js and
// does not resolve tsconfig path aliases.
import { AUTH_DRIZZLE_CONFIG } from "./src/lib/auth-drizzle-config";

/**
 * Static Better Auth config consumed ONLY by the schema generator:
 *
 *   pnpm dlx auth@<better-auth version> generate \
 *     --config better-auth.config.ts --output src/db/auth-schema.ts -y
 *
 * The runtime instance lives in `src/lib/auth.ts` and is deliberately lazy
 * (`auth()`), so importing it never reads env or opens a connection. The CLI
 * cannot consume a lazy factory — it expects a plain `auth` export — hence
 * this file. Nothing in `src/` imports it.
 *
 * Only options that affect the generated tables matter here: the drizzle
 * adapter shape (shared via `AUTH_DRIZZLE_CONFIG`, so it cannot drift from the
 * runtime) and the plugin list. `magicLink` adds no tables of its own — it
 * reuses the core `verifications` table — but it is listed so the generated
 * schema stays correct if that ever changes. Secrets, base URL and social
 * providers are runtime-only and intentionally absent.
 *
 * The adapter's first argument is the Drizzle client, which the generator
 * never touches (it only reads the config), so an empty object is passed.
 */
export const auth = betterAuth({
  database: drizzleAdapter({}, AUTH_DRIZZLE_CONFIG),
  plugins: [
    magicLink({
      sendMagicLink: async () => {
        // Never invoked: the generator does not run request handlers.
      },
    }),
  ],
});
