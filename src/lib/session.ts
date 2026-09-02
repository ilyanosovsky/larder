import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { auth } from "@/lib/auth";

export type Session = Awaited<
  ReturnType<ReturnType<typeof auth>["api"]["getSession"]>
>;

/**
 * Reads the validated session for the current request — the authoritative
 * check, as opposed to the optimistic cookie check in `src/middleware.ts`.
 * For use in server components, layouts and server actions.
 *
 * `headers()` is awaited *before* `auth()` on purpose: during `next build`
 * the dynamic-API bailout is thrown by that first await, so `auth()` — and
 * therefore `env()` and `db()` — is never reached while prerendering. This is
 * what keeps a zero-environment build working.
 *
 * **Memoized per request** with React's `cache()`. A page renders one
 * `createTRPCContext()` per prefetch plus one for the layout's own `caller`
 * call, and each of those starts here — so `/` used to run the session lookup
 * (a cookie verification and a `sessions` read) five times over. One lookup
 * per request instead is what pays for `HydrateClient` now awaiting those
 * prefetches before it dehydrates. Outside a render — route handlers, server
 * actions — `cache()` is a pass-through, so nothing there changes.
 */
export const getSession = cache(async (): Promise<Session> => {
  const requestHeaders = await headers();

  return auth().api.getSession({ headers: requestHeaders });
});
