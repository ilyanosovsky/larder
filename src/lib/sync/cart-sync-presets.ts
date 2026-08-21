/**
 * How often the cart polls while its screen is open, in ms.
 *
 * VISION §6.3 asks for a "мягкий фоновый интервал (~30–60 с)" — a soft
 * background poll, not a promise of instant delivery (that is realtime
 * push, post-MVP). 45s is the middle of that band.
 */
export const CART_REFETCH_INTERVAL_MS = 45_000;

/**
 * Refetch preset for the cart-family queries (`cart.list` and, later,
 * anything else task 2.3+ renders alongside it), spread into the
 * `queryOptions()` call site the way `autocomplete-sheet.tsx` already
 * spreads a `placeholderData: keepPreviousData` override into
 * `trpc.product.search.queryOptions(...)`:
 *
 * ```ts
 * useQuery(trpc.cart.list.queryOptions(undefined, { ...cartSyncQueryOptions }))
 * ```
 *
 * Deliberately **not** set as a `QueryClient` default in
 * `src/trpc/query-client.ts`. That file's `staleTime: 30_000` exists so a
 * server-prefetched query survives hydration without an immediate refetch —
 * a concern shared by every screen. An aggressive poll-and-always-refetch
 * policy is not: the catalog, settings and kitchen-profile screens have no
 * partner racing to see their own edits, and polling them every 45s would
 * just burn requests for no one. The cart is the one shared, actively
 * edited list in the app (VISION §3.1), so it opts in on its own.
 */
export const cartSyncQueryOptions = {
  refetchInterval: CART_REFETCH_INTERVAL_MS,
  /**
   * "always" rather than the default (stale-only) refetch-on-focus /
   * refetch-on-reconnect behavior.
   *
   * `query-client.ts` sets `staleTime: 30_000` for SSR-hydration reasons
   * unrelated to the cart (see the comment there). Under the *default*
   * focus/reconnect behavior, TanStack Query only refetches a query that is
   * already stale — so a focus event landing inside that 30s window would
   * be a silent no-op, exactly at the "opened the phone by the shelf"
   * moment VISION §6.3 is built around. "always" refetches regardless of
   * staleness, which is what a list a partner can be editing right now
   * needs: fresh at every look, not just every look 30s apart.
   */
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always",
} as const;
