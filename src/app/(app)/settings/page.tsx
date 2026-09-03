import { getTranslations } from "next-intl/server";

import { caller, HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishArchiveSection } from "./dish-archive-section";
import { HouseholdSection } from "./household-section";
import { KitchenProfileSection } from "./kitchen-profile-section";
import styles from "./settings-page.module.css";
import { TripHistorySection } from "./trip-history-section";

/**
 * S12 Settings — four real blocks: the household (name, members, invite
 * link, and — since task 7.1a — the identity/sign-out line the page footer
 * used to hold), the kitchen profile, the purchase history «Завершить
 * закупку» produces (task 3.2), and the dish archive «В архив» on S7 fills
 * (task 4.1). The rest of S12's full assembly (departments drag order, AI
 * budget, language) is task 7.1.
 */
export default async function SettingsPage() {
  const t = await getTranslations("settings");
  // Proof of life for the tRPC scaffold (task 0.4): context, protected
  // procedure and the server-side caller in one line. `HouseholdSection`
  // needs the caller's own id to mark their row «ты».
  const me = await caller.health.whoami();

  // Same wiring as the catalog screen (src/app/(app)/page.tsx): started
  // during the RSC render so each section's own query hydrates instead of
  // fetching one waterfall later.
  prefetch(trpc.household.current.queryOptions());
  prefetch(trpc.kitchenProfile.get.queryOptions());
  prefetch(trpc.trip.list.queryOptions());
  prefetch(trpc.dish.listArchived.queryOptions());

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>{t("title")}</h1>

      <HydrateClient>
        <HouseholdSection callerId={me.id} email={me.email} />
        <KitchenProfileSection />
        <TripHistorySection />
        <DishArchiveSection />
      </HydrateClient>
    </div>
  );
}
