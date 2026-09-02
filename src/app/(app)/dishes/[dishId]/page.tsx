import { notFound } from "next/navigation";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishScreen } from "./dish-screen";

/**
 * S7 «Карточка блюда» — one dish, read-only (VISION §3.3).
 *
 * `dish.get` is the only prefetch: «дома есть ✓» rides inside it as a
 * `pantry_items` join, so `pantry.list` is not needed, and the kitchen
 * profile the equipment banner compares against is task 4.5's to fetch.
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

  return (
    <HydrateClient>
      <DishScreen dishId={dishId} />
    </HydrateClient>
  );
}
