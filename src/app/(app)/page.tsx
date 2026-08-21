import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { CartScreen } from "./cart-screen";

/**
 * The «Покупки» tab: S3 «Корзина», the product's main screen (VISION §3.1).
 *
 * Both queries the screen needs start during the RSC render, so they are
 * already in the client cache when it hydrates instead of arriving one
 * waterfall later. `cart.list` is what the screen renders; `category.list` is
 * what the «изменить продукт» form inside S4 needs the moment someone taps
 * «Изменить» on a freshly created product.
 */
export default function PurchasesPage() {
  prefetch(trpc.cart.list.queryOptions());
  prefetch(trpc.category.list.queryOptions());

  return (
    <HydrateClient>
      <CartScreen />
    </HydrateClient>
  );
}
