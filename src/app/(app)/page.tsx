import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { CatalogScreen } from "./catalog-screen";

/**
 * The «Покупки» tab. Task 1.3 puts the household product catalog here; task
 * 2.3 replaces it with S3 «Корзина» proper, which reads from the same router.
 *
 * Both queries the screen needs are started during the RSC render, so the
 * catalog and the department list are already in the client cache when it
 * hydrates instead of arriving one waterfall later. `product.list` is what
 * the screen renders; `category.list` is what the «изменить продукт» form
 * needs the moment a row is tapped.
 */
export default function PurchasesPage() {
  prefetch(trpc.product.list.queryOptions());
  prefetch(trpc.category.list.queryOptions());

  return (
    <HydrateClient>
      <CatalogScreen />
    </HydrateClient>
  );
}
