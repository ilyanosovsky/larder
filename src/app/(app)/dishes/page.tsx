import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { DishLibraryScreen } from "./dish-library-screen";

/**
 * The «Блюда» tab — S6, the household's recipe library (VISION §3.3).
 *
 * One prefetch and no more: the grid renders from `dish.list` alone, and a
 * per-tile `dish.get` would be N queries for a screen where at most one card
 * is ever tapped. Search and tag filtering are client-side over that single
 * cache entry (`filterDishes`), so no keystroke costs a request either.
 */
export default function DishesPage() {
  prefetch(trpc.dish.list.queryOptions());

  return (
    <HydrateClient>
      <DishLibraryScreen />
    </HydrateClient>
  );
}
