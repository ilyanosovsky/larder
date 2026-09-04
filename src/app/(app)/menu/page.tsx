import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { MenuScreen } from "./menu-screen";

/**
 * The «Меню» tab — S10, this week's pool of dishes (VISION §3.4).
 *
 * **Two prefetches.** `menu.current` is the screen. `dish.list` is the «+
 * Блюдо» picker: it is one cache entry, already warmed by `/dishes`, and
 * prefetching it here is what makes the sheet open with its list already in
 * it rather than on a spinner — the picker filters that array client-side
 * (`filterDishes`), so no keystroke inside it costs a request either.
 *
 * Because this route prefetches, it needs its own `loading.tsx` covering the
 * whole `menu` segment (the rule `src/trpc/server.tsx` states).
 */
export default function MenuPage() {
  prefetch(trpc.menu.current.queryOptions());
  prefetch(trpc.dish.list.queryOptions());

  return (
    <HydrateClient>
      <MenuScreen />
    </HydrateClient>
  );
}
