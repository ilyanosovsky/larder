import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { LOGIN_PATH, ONBOARDING_PATH } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";
import { caller } from "@/trpc/server";

/**
 * Every signed-in screen lives under this group, so the two authoritative
 * checks happen once here.
 *
 * 1. Session. `src/middleware.ts` already turned most anonymous visitors away
 *    on the cookie alone; this catches the rest — a stale, forged or expired
 *    cookie — before any page renders.
 * 2. Household. Every screen in the group is household-scoped, and the data
 *    procedures behind them run on `householdProcedure` (VISION §6.7), so a
 *    user who has not finished onboarding (S2) is sent there rather than
 *    shown a shell full of FORBIDDEN. `/onboarding` and `/invite/[token]`
 *    deliberately live outside this group, or the redirect would loop.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect(LOGIN_PATH);
  }

  const household = await caller.household.current();

  if (!household) {
    redirect(ONBOARDING_PATH);
  }

  return <AppShell>{children}</AppShell>;
}
