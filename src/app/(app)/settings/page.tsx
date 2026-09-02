import { getTranslations } from "next-intl/server";

import { SignOutButton } from "@/components/sign-out-button";
import { caller, HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishArchiveSection } from "./dish-archive-section";
import { KitchenProfileSection } from "./kitchen-profile-section";
import styles from "./settings-page.module.css";
import { TripHistorySection } from "./trip-history-section";

/**
 * S12 Settings — still a scaffold (task 1.4), now with three real blocks: the
 * kitchen profile, the purchase history «Завершить закупку» produces (task
 * 3.2), and the dish archive «В архив» on S7 fills (task 4.1). Full S12
 * assembly (household/members, invite link, expandable trip rows,
 * departments, AI budget) is task 7.1, which extends this same section
 * structure — the identity/sign-out block is expected to move into a
 * "Household" section then, not stay pinned at the bottom forever.
 */
export default async function SettingsPage() {
  const t = await getTranslations("settings");
  // Proof of life for the tRPC scaffold (task 0.4): context, protected
  // procedure and the server-side caller in one line.
  const me = await caller.health.whoami();

  // Same wiring as the catalog screen (src/app/(app)/page.tsx): started
  // during the RSC render so each section's own query hydrates instead of
  // fetching one waterfall later.
  prefetch(trpc.kitchenProfile.get.queryOptions());
  prefetch(trpc.trip.list.queryOptions());
  prefetch(trpc.dish.listArchived.queryOptions());

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>{t("title")}</h1>

      <HydrateClient>
        <KitchenProfileSection />
        <TripHistorySection />
        <DishArchiveSection />
      </HydrateClient>

      <div className={styles.footer}>
        <p className={styles.identity}>
          {t("signedInAs", { email: me.email })}
        </p>
        <SignOutButton />
      </div>
    </div>
  );
}
