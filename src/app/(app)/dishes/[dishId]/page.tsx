import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishScreen } from "./dish-screen";

/**
 * S7 «Карточка блюда» — one dish, read-only (VISION §3.3).
 *
 * `dish.get` is the only prefetch: «дома есть ✓» rides inside it as a
 * `pantry_items` join, so `pantry.list` is not needed, and the kitchen
 * profile the equipment banner compares against is task 4.5's to fetch.
 */
export default async function DishPage({
  params,
}: {
  params: Promise<{ dishId: string }>;
}) {
  const { dishId } = await params;

  prefetch(trpc.dish.get.queryOptions({ id: dishId }));

  return (
    <HydrateClient>
      <DishScreen dishId={dishId} />
    </HydrateClient>
  );
}
