import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Shared Better Auth browser client for client components.
 *
 * No `baseURL` is configured on purpose: the client falls back to the current
 * origin (`/api/auth`), so the browser bundle needs no environment variable
 * and the same build works on localhost and in production.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});
