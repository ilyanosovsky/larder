import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { PurchasesScreen } from "../purchases-screen";

/**
 * The «Покупки» tab: the S3/S5 segment control over «Корзина» and «Кладовая»
 * (VISION §3.1, §3.2; task 3.1 added the pantry half and the control itself).
 *
 * **The `(purchases)` route group exists only to scope `loading.tsx`.** A
 * `loading.tsx` is the Suspense fallback for every child slot of its segment,
 * so a cart skeleton sitting directly under `(app)` would also be what
 * `/menu` and `/assistant` show on a tab tap — and their client-reference
 * manifests would carry the cart chunk. The group gives `/` its own boundary
 * without touching the URL; the sibling tabs prefetch nothing and keep their
 * pre-existing "no fallback, previous screen stays" behaviour.
 *
 * Four queries start during the RSC render, so they are already in the
 * client cache when it hydrates instead of arriving one waterfall later.
 * `cart.list` and `pantry.list` are what the two screens render — both are
 * prefetched up front rather than only the tab that happens to be selected
 * first, since switching tabs is the whole point of this page and a second
 * client-side round trip on the very first tap would defeat prefetching
 * entirely. `category.list` is what the «изменить продукт» form inside S4
 * needs the moment someone taps «Изменить» on a freshly created product;
 * `household.current` is what the cart's row action sheet's «кто берёт» chips
 * need (task 2.5) — the `(app)` layout already loads it for its own gate, but
 * that is a plain server-side call, not a client-cache entry, so the page
 * prefetches its own copy rather than threading it down as a prop through a
 * layout that hands the page an opaque `children`.
 */
export default function PurchasesPage() {
  prefetch(trpc.cart.list.queryOptions());
  prefetch(trpc.pantry.list.queryOptions());
  prefetch(trpc.category.list.queryOptions());
  prefetch(trpc.household.current.queryOptions());

  return (
    <HydrateClient>
      <PurchasesScreen />
    </HydrateClient>
  );
}
