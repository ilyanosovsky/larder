import { getTranslations } from "next-intl/server";

import { DishSkeleton } from "./dish-screen";

/**
 * S7's pending state — the same skeleton `DishScreen` renders while `dish.get`
 * is in flight, shown while the page's own two prefetches run (`HydrateClient`
 * awaits them before dehydrating, see `src/trpc/settle-queries.ts`). Tapping a
 * tile in the library therefore lands on the card's shape immediately instead
 * of holding the library on screen until the dish is loaded.
 */
export default async function DishLoading() {
  const t = await getTranslations("dish");

  return <DishSkeleton label={t("loading")} />;
}
