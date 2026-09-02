import { getTranslations } from "next-intl/server";

import { LibrarySkeleton } from "./dish-library-screen";

/**
 * S6's pending state — the same skeleton tiles `DishLibraryScreen` renders
 * while `dish.list` is in flight, shown while the page's own prefetch runs
 * (`HydrateClient` awaits it before dehydrating, see
 * `src/trpc/settle-queries.ts`).
 */
export default async function DishesLoading() {
  const t = await getTranslations("dishes");

  return <LibrarySkeleton label={t("loading")} />;
}
