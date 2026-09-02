import { notFound } from "next/navigation";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishScreen } from "./dish-screen";

/**
 * S7 «Карточка блюда» — one dish, read-only (VISION §3.3).
 *
 * Two prefetches: `dish.get` («дома есть ✓» rides inside it as a
 * `pantry_items` join, so `pantry.list` is not needed) and `kitchenProfile
 * .get`, task 4.5's own equipment banner comparing against it. Both are
 * fire-and-forget (`prefetch()`'s own contract), so the two can still resolve
 * on the client a beat apart — the banner renders nothing rather than a wrong
 * answer for that instant (see `EquipmentBanner`'s doc comment).
 *
 * **The route segment is validated before it becomes a query.** `dishIdInput`
 * is `z.uuid()`, so a hand-typed or mis-shared `/dishes/oladi` would be
 * refused by tRPC's input middleware as `BAD_REQUEST` — which the screen
 * would render as a retryable load failure whose retry can only fail the same
 * way. A malformed id is not a dish that failed to load, it is a URL that
 * names no dish, so it gets Next's own 404 here; that also skips the session
 * and household-membership round trips the procedure would otherwise run
 * before its input is even parsed.
 */
export default async function DishPage({
  params,
}: {
  params: Promise<{ dishId: string }>;
}) {
  const { dishId } = await params;

  if (!z.uuid().safeParse(dishId).success) {
    notFound();
  }

  prefetch(trpc.dish.get.queryOptions({ id: dishId }));
  prefetch(trpc.kitchenProfile.get.queryOptions());

  return (
    <HydrateClient>
      <DishScreen dishId={dishId} />
    </HydrateClient>
  );
}
