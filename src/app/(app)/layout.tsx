import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { LOGIN_PATH } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";

/**
 * Every signed-in screen lives under this group, so the authoritative session
 * check happens once here. `src/middleware.ts` already turned most anonymous
 * visitors away on the cookie alone; this catches the rest — a stale, forged
 * or expired cookie — before any page renders.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect(LOGIN_PATH);
  }

  return <AppShell>{children}</AppShell>;
}
