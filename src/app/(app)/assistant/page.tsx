import { getTranslations } from "next-intl/server";

import { PlaceholderScreen } from "@/components/placeholder-screen";

export default async function AssistantPage() {
  const t = await getTranslations("placeholders");

  return <PlaceholderScreen message={t("assistant")} />;
}
