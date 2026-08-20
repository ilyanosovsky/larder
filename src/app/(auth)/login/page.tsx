import { redirect } from "next/navigation";

import { sanitizeNextPath } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";

import { LoginScreen } from "./login-screen";

/**
 * S1 «Вход» (DESIGN_BRIEF §4). Rendered outside the `(app)` group, so there
 * are no tabs and no sidebar.
 *
 * Bouncing an already signed-in visitor onwards happens here rather than in
 * the middleware on purpose — see `resolveAuthRedirect` for why the cookie
 * alone must not be trusted for this direction.
 *
 * `?next=` remembers where the visitor was headed before the middleware
 * intercepted them; `sanitizeNextPath` is what keeps that from becoming an
 * open redirect, and falls back to the home screen for anything suspicious.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  const { next } = await searchParams;
  const target = sanitizeNextPath(Array.isArray(next) ? next[0] : next);

  if (session) {
    redirect(target);
  }

  return <LoginScreen next={target} />;
}
