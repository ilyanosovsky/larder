import { redirect } from "next/navigation";

import { HOME_PATH, LOGIN_PATH } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";
import { caller } from "@/trpc/server";

import { OnboardingScreen } from "./onboarding-screen";

/**
 * S2 «Онбординг household» (DESIGN_BRIEF §4). Rendered outside the `(app)`
 * group: it is where the household gate in that layout sends people, so it
 * must not be behind the same gate.
 *
 * `getSession()` is awaited before the tRPC caller for the same reason as
 * everywhere else — it throws Next's dynamic bailout during `next build`, so
 * nothing here ever needs environment variables at build time.
 */
export default async function OnboardingPage() {
  const session = await getSession();

  if (!session) {
    redirect(LOGIN_PATH);
  }

  const current = await caller.household.current();

  if (current) {
    redirect(HOME_PATH);
  }

  return <OnboardingScreen />;
}
