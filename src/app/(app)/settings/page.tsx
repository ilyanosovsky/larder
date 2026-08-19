import { getTranslations } from "next-intl/server";

import { PlaceholderScreen } from "@/components/placeholder-screen";
import { SignOutButton } from "@/components/sign-out-button";

export default async function SettingsPage() {
  const t = await getTranslations("placeholders");

  return (
    <>
      <PlaceholderScreen message={t("settings")} />
      <SignOutButton />
    </>
  );
}
