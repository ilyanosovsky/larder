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

/** Query parameter carrying where the visitor was headed before the login. */
export const NEXT_PARAM = "next";

/**
 * Turns a `next` value from the URL into a path that is safe to navigate to.
 *
 * Everything here arrives from the query string, so it is attacker-controlled:
 * without this check `/login?next=https://evil.example` would turn our own
 * sign-in into an open redirect, handing someone a phishing page on the back
 * of a link that starts with our domain. Anything that is not plainly an
 * in-app path falls back to the home screen rather than erroring — a mangled
 * link should still sign you in.
 */
export function sanitizeNextPath(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    return HOME_PATH;
  }

  // Must be an absolute path on this origin.
  if (!value.startsWith("/")) {
    return HOME_PATH;
  }

  // `//evil.example` is a protocol-relative URL, and browsers normalise the
  // backslash form to the same thing — both leave our origin.
  if (value.startsWith("//") || value.startsWith("/\\")) {
    return HOME_PATH;
  }

  // Control characters and whitespace are how a second URL gets smuggled
  // past a naive prefix check (e.g. "/\n//evil.example"): browsers strip
  // them before resolving the location. Note that a plain hyphen is fine —
  // invite tokens are base64url and contain them.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return HOME_PATH;
  }

  // Returning to the login screen after logging in would just bounce.
  if (value === LOGIN_PATH || value.startsWith(`${LOGIN_PATH}/`)) {
    return HOME_PATH;
  }

  return value;
}

/**
 * The login URL to send someone to, remembering where they were going.
 *
 * The common case this exists for: a partner taps an invite link while signed
 * out. Without the round trip back to `/invite/<token>` they land on the cart,
 * get bounced to onboarding, and may well create a household of their own —
 * at which point the invitation can never be accepted (one household per
 * user, and MVP has no way to leave one).
 */
export function loginPathFor(pathname: string): string {
  const target = sanitizeNextPath(pathname);

  if (target === HOME_PATH) {
    return LOGIN_PATH;
  }

  return `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(target)}`;
}

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

  return loginPathFor(pathname);
}
