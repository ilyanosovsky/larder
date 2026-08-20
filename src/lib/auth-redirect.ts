/** Login screen (S1). Rendered without the app shell — see `src/app/(auth)`. */
export const LOGIN_PATH = "/login";

/** Landing route after a successful sign-in: the cart (S3). */
export const HOME_PATH = "/";

/**
 * Onboarding (S2) — create a household or learn how to join one. Signed in
 * but household-less users are sent here by `src/app/(app)/layout.tsx`. Not
 * part of the middleware's decision: it stays behind the auth gate like every
 * other screen.
 */
export const ONBOARDING_PATH = "/onboarding";

export interface AuthRedirectInput {
  /** Pathname of the incoming request, e.g. `/menu`. */
  pathname: string;
  /**
   * Whether a Better Auth session cookie is present. Existence only — the
   * cookie is not validated here; `getSession()` does that in the layout.
   */
  hasSessionCookie: boolean;
}

/**
 * Decides where the edge middleware should send a request, or `null` to let it
 * through. Pure so the rule is unit-testable without a Next.js request.
 *
 * Deliberately one-directional: a request without a session cookie is bounced
 * off app routes, but a request *with* one is never bounced off `/login`.
 * Doing the latter optimistically would trap anyone holding a stale cookie in
 * a redirect loop — middleware sees the cookie and sends them to `/`, the app
 * layout validates it, finds no session and sends them back to `/login`, and
 * so on. Sending a genuinely signed-in visitor from `/login` to `/` is instead
 * done by the login page itself, which checks the real session.
 */
export function resolveAuthRedirect({
  pathname,
  hasSessionCookie,
}: AuthRedirectInput): string | null {
  if (pathname === LOGIN_PATH || hasSessionCookie) {
    return null;
  }

  return LOGIN_PATH;
}
