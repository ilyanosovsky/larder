import { getTranslations } from "next-intl/server";

import { CartSkeleton } from "./cart-screen";

/**
 * The pending state of the «Покупки» tab, and the fallback the rest of the
 * group inherits.
 *
 * `HydrateClient` awaits this page's prefetches before it dehydrates (see
 * `src/trpc/settle-queries.ts`), so the page's own HTML now arrives with its
 * rows already in it — which is the point, but it also means the segment has
 * nothing to show while those queries run. This file is what Next streams in
 * the meantime: DESIGN_BRIEF §6's «первая загрузка списков — скелетоны», kept
 * literally the same component the screen renders while a client-side refetch
 * is pending, so the shape does not change when the data lands. It also gives
 * a tab tap its instant feedback: without it a client-side navigation would
 * sit on the previous screen until the new one's data was ready.
 *
 * The cart's skeleton rather than a generic one: `PurchasesScreen` opens on
 * «Корзина» (its `tab` state defaults to `"cart"`), so this is the shape that
 * actually follows.
 */
export default async function PurchasesLoading() {
  const t = await getTranslations("cart");

  return <CartSkeleton label={t("loading")} />;
}
