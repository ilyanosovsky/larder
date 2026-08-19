import { getTranslations } from "next-intl/server";

import { PlaceholderScreen } from "@/components/placeholder-screen";
import { SignOutButton } from "@/components/sign-out-button";
import { caller } from "@/trpc/server";

import styles from "./settings-page.module.css";

export default async function SettingsPage() {
  const t = await getTranslations();
  // Proof of life for the tRPC scaffold (task 0.4): context, protected
  // procedure and the server-side caller in one line. The real settings
  // screen is task 7.1.
  const me = await caller.health.whoami();

  return (
    <>
      <PlaceholderScreen message={t("placeholders.settings")} />
      <p className={styles.identity}>
        {t("settings.signedInAs", { email: me.email })}
      </p>
      <SignOutButton />
    </>
  );
}
