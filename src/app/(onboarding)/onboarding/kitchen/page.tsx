import { redirect } from "next/navigation";

import {
  loginPathFor,
  ONBOARDING_KITCHEN_PATH,
  ONBOARDING_PATH,
} from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";
import { caller } from "@/trpc/server";

import { KitchenOnboardingScreen } from "./kitchen-onboarding-screen";

/**
 * S2 «Профиль кухни» step (DESIGN_BRIEF §4 S2, task 1.4). Lives outside the
 * `(app)` group, next to `/onboarding`: it is only ever reached partway
 * through onboarding, not as a screen the household gate should send anyone
 * back to.
 *
 * Same two authoritative checks as `/onboarding` itself — `getSession()` is
 * still awaited first, not left to the middleware's optimistic cookie check
 * alone, for the same dynamic-API-bailout reason documented there. Without a
 * household this step has nothing to attach a profile to, so it bounces back
 * to `/onboarding` rather than rendering a form that would fail on submit.
 */
export default async function OnboardingKitchenPage() {
  const session = await getSession();

  if (!session) {
    redirect(loginPathFor(ONBOARDING_KITCHEN_PATH));
  }

  const household = await caller.household.current();

  if (!household) {
    redirect(ONBOARDING_PATH);
  }

  return <KitchenOnboardingScreen />;
}
