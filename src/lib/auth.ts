import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";

import { db } from "@/db";
import * as authSchema from "@/db/auth-schema";
import { AUTH_DRIZZLE_CONFIG } from "@/lib/auth-drizzle-config";
import { env } from "@/lib/env";
import {
  MAGIC_LINK_EXPIRES_IN_SECONDS,
  renderMagicLinkEmail,
} from "@/lib/magic-link-email";

function createAuth() {
  const resend = new Resend(env().RESEND_API_KEY);
  const from = env().EMAIL_FROM;

  return betterAuth({
    database: drizzleAdapter(db(), {
      ...AUTH_DRIZZLE_CONFIG,
      schema: authSchema,
    }),
    secret: env().BETTER_AUTH_SECRET,
    baseURL: env().BETTER_AUTH_URL,
    socialProviders: {
      google: {
        clientId: env().GOOGLE_CLIENT_ID,
        clientSecret: env().GOOGLE_CLIENT_SECRET,
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        sendMagicLink: async ({ email, url }) => {
          const { subject, html, text } = renderMagicLinkEmail(url);
          const { error } = await resend.emails.send({
            from,
            to: email,
            subject,
            html,
            text,
          });

          if (error) {
            // Surface the failure so Better Auth returns an error to the
            // client instead of silently pretending the mail was sent.
            throw new Error(`Resend rejected the magic link: ${error.message}`);
          }
        },
      }),
      // Must stay last — it rewrites cookies set by the plugins above
      // (Better Auth Next.js integration docs).
      nextCookies(),
    ],
  });
}

let cached: ReturnType<typeof createAuth> | undefined;

/**
 * Lazily-created singleton Better Auth instance.
 *
 * Creation is intentionally lazy — it happens on first call, not on module
 * import — so importing this module never reads env or opens a connection,
 * mirroring `env()` and `db()`. `pnpm build` runs in CI with no environment
 * variables set at all and must still succeed; only request-time code paths
 * that actually call `auth()` need the variables to be present. That is why
 * the route handler in `src/app/api/auth/[...all]/route.ts` wraps this call
 * in a per-request closure rather than passing the instance directly.
 */
export function auth(): ReturnType<typeof createAuth> {
  if (!cached) {
    cached = createAuth();
  }
  return cached;
}
