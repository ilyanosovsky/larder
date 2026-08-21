import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { CartScreen } from "./cart-screen";

/**
 * The «Покупки» tab: S3 «Корзина», the product's main screen (VISION §3.1).
 *
 * Three queries the screen needs start during the RSC render, so they are
 * already in the client cache when it hydrates instead of arriving one
 * waterfall later. `cart.list` is what the screen renders; `category.list` is
 * what the «изменить продукт» form inside S4 needs the moment someone taps
 * «Изменить» on a freshly created product; `household.current` is what the
 * row action sheet's «кто берёт» chips need (task 2.5) — the `(app)` layout
 * already loads it for its own gate, but that is a plain server-side call,
 * not a client-cache entry, so the screen prefetches its own copy rather than
 * threading it down as a prop through a layout that hands the page an opaque
 * `children`.
 */
export default function PurchasesPage() {
  prefetch(trpc.cart.list.queryOptions());
  prefetch(trpc.category.list.queryOptions());
  prefetch(trpc.household.current.queryOptions());

  return (
    <HydrateClient>
      <CartScreen />
    </HydrateClient>
  );
}
