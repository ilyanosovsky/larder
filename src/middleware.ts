import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { resolveAuthRedirect } from "@/lib/auth-redirect";

/**
 * Optimistic auth gate. `getSessionCookie` only checks that a session cookie
 * exists — it never validates it and never touches the database — which is
 * exactly what the Better Auth Next.js docs recommend for middleware. The
 * authoritative check runs in `src/app/(app)/layout.tsx` via `getSession()`.
 *
 * Two known constraints, both verified against Next.js 15.5:
 * - `better-auth/cookies` transitively imports `jose`, so `next build` prints
 *   an Edge-runtime warning about `CompressionStream`. The code path is never
 *   reached here (only the cookie parser is used) and the build succeeds.
 * - `runtime: "nodejs"` in the config below would silence that warning, but
 *   this Next version drops the middleware from `middleware-manifest.json`
 *   entirely when it is set — the gate would stop running. Keep it on Edge.
 */
export function middleware(request: NextRequest): NextResponse {
  const target = resolveAuthRedirect({
    pathname: request.nextUrl.pathname,
    hasSessionCookie: getSessionCookie(request) !== null,
  });

  if (target === null) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL(target, request.url));
}

export const config = {
  // Everything except `/api/**` (the auth handler must stay reachable while
  // signed out), Next internals and files with an extension (icon.svg,
  // manifest.webmanifest, …). Written as an exclusion so routes added later
  // are protected by default instead of being forgotten here.
  matcher: ["/((?!api|_next/static|_next/image|.*\\.).*)"],
};
