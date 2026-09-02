import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { NewDishScreen } from "./new-dish-screen";

/**
 * «✍️ Вручную» — S8.3 with an empty draft (DESIGN_BRIEF S6: «„Вручную“
 * открывает пустую форму блюда — ту же, что подэкран S8.3»).
 *
 * `category.list` is the only prefetch, and it is not for this screen: the
 * rebind sheet's «Изменить продукт» panel needs the household's departments
 * the instant it opens, and a bottom sheet that spins on its first tap is the
 * one place that delay is visible. Nothing else is fetched — a blank form has
 * no server state of its own.
 */
export default function NewDishPage() {
  prefetch(trpc.category.list.queryOptions());

  return (
    <HydrateClient>
      <NewDishScreen />
    </HydrateClient>
  );
}
