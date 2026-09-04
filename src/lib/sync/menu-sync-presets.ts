/**
 * Refetch preset for `menu.current` — focus and reconnect, **no interval**.
 *
 * The pool is shared and both partners edit it, so a stale one is a real
 * error: you add Том-ям, your partner adds it too, and one of you sees a card
 * that is not there. `"always"` rather than the default stale-only behaviour
 * for the same reason the cart needs it — `query-client.ts` sets
 * `staleTime: 30_000` for SSR-hydration reasons, and a focus inside that
 * window would otherwise be a silent no-op.
 *
 * **No `refetchInterval`, unlike `cartSyncQueryOptions`.** That preset's own
 * doc comment justifies its 45s poll by the moment VISION §6.3 is built
 * around: two people in a shop, one ticking lines the other is looking at.
 * Nobody stands in a menu screen waiting for their partner; a weekly plan is
 * edited in bursts, minutes apart. Polling it would burn a request every 45
 * seconds for a screen that changes a few times a week.
 *
 * No `gcTime` override either: `createOfflineCacheFilters` dehydrates
 * `cart.list` alone, so nothing menu-shaped ever reaches IndexedDB, and a
 * menu kept warm for hours would only grow the in-memory cache for a screen
 * that is useless offline anyway.
 *
 * Spread into the `queryOptions()` call site, the way `cartSyncQueryOptions`
 * is:
 *
 * ```ts
 * useQuery(trpc.menu.current.queryOptions(undefined, { ...menuSyncQueryOptions }))
 * ```
 */
export const menuSyncQueryOptions = {
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always",
} as const;
