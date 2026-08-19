import { redirect } from "next/navigation";

import { HOME_PATH } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";

import { LoginScreen } from "./login-screen";

/**
 * S1 «Вход» (DESIGN_BRIEF §4). Rendered outside the `(app)` group, so there
 * are no tabs and no sidebar.
 *
 * Bouncing an already signed-in visitor to the cart happens here rather than
 * in the middleware on purpose — see `resolveAuthRedirect` for why the cookie
 * alone must not be trusted for this direction.
 */
export default async function LoginPage() {
  const session = await getSession();

  if (session) {
    redirect(HOME_PATH);
  }

  return <LoginScreen />;
}
