import { getTranslations } from "next-intl/server";

import { PlaceholderScreen } from "@/components/placeholder-screen";
import { SignOutButton } from "@/components/sign-out-button";
import { caller, HydrateClient, prefetch, trpc } from "@/trpc/server";

import { KitchenProfileSection } from "./kitchen-profile-section";
import styles from "./settings-page.module.css";

/**
 * S12 «Настройки» — a minimal scaffold (task 1.4): signed-in identity,
 * sign-out, and the first real settings block, «Профиль кухни». Full S12
 * assembly (household/members, invite link, purchase history, departments,
 * AI budget) is task 7.1, which extends this same section structure.
 */
export default async function SettingsPage() {
  const t = await getTranslations();
  // Proof of life for the tRPC scaffold (task 0.4): context, protected
  // procedure and the server-side caller in one line.
  const me = await caller.health.whoami();

  // Same wiring as the catalog screen (src/app/(app)/page.tsx): started
  // during the RSC render so the section's own query hydrates instead of
  // fetching one waterfall later.
  prefetch(trpc.kitchenProfile.get.queryOptions());

  return (
    <>
      <PlaceholderScreen message={t("placeholders.settings")} />
      <p className={styles.identity}>
        {t("settings.signedInAs", { email: me.email })}
      </p>
      <SignOutButton />
      <HydrateClient>
        <KitchenProfileSection />
      </HydrateClient>
    </>
  );
}
