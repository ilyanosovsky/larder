"use client";

import { useQueryClient, type QueryFilters } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ManualRefresh {
  /** Awaits `queryClient.refetchQueries(filter)`. Safe to call again while
   * already refreshing: `isRefreshing` is tracked by an in-flight counter,
   * not by which particular call's promise resolves first, so an overlapping
   * second tap cannot make it drop back to `false` while a refetch it
   * triggered is still running (see the module doc comment). */
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
}

/**
 * The «Обновить» / pull-to-refresh primitive (VISION §6.3): a person's own
 * "no really, check now" request, on top of the passive refetch triggers
 * `cartSyncQueryOptions` already covers.
 *
 * `filter` is the `trpc.cart.list.queryFilter()` idiom used elsewhere for
 * invalidation (see `queryClient.invalidateQueries(trpc.product.list.queryFilter())`
 * in `catalog-screen.tsx`) — a `QueryFilters` pinned to one query's key by
 * tRPC's option-proxy, not a hand-rolled key array.
 *
 * Two things this is *not* as thin a shell as it looks:
 *
 * - `refetchQueries` does not dedupe overlapping calls — it defaults to
 *   `cancelRefetch: true`, which **cancels** whatever fetch is already in
 *   flight and starts a new one. The cancelled call's own promise still
 *   resolves (a swallowed `CancelledError`, not a rejection), so a naive
 *   `setIsRefreshing(true)`/`finally { setIsRefreshing(false) }` around a
 *   single call would flip `isRefreshing` back to `false` the moment the
 *   *first* of two overlapping taps settles, even though the second tap's
 *   fetch — the one that actually wins — is still running. `inFlightRef`
 *   counts outstanding `refresh()` calls instead of trusting any one of
 *   their promises, so `isRefreshing` only drops once every outstanding
 *   call has settled, regardless of which one physically resolves first.
 * - `filters.type` defaults to `"all"` (`matchQuery`, `@tanstack/query-core`),
 *   which also matches queries that are cached but currently unmounted. A
 *   person tapping «Обновить» means the screen in front of them, not every
 *   query under that key prefix that happens to still be in the cache —
 *   hence `type: "active"` below, overridable by whatever `filter` itself
 *   already specifies.
 *
 * `filter` is read through a ref, kept in sync via effect rather than a
 * `useCallback` dependency: the `trpc.cart.list.queryFilter()` idiom builds
 * a new object every render, which would otherwise make `refresh`'s
 * identity churn every render too — useless as a memoized callback handed
 * to a child component, which is exactly how 2.3 is expected to use it.
 */
export function useManualRefresh(filter: QueryFilters): ManualRefresh {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlightRef = useRef(0);
  const filterRef = useRef(filter);

  useEffect(() => {
    filterRef.current = filter;
  });

  const refresh = useCallback(async () => {
    inFlightRef.current += 1;
    setIsRefreshing(true);
    try {
      await queryClient.refetchQueries({
        type: "active",
        ...filterRef.current,
      });
    } finally {
      inFlightRef.current -= 1;
      setIsRefreshing(inFlightRef.current > 0);
    }
  }, [queryClient]);

  return { refresh, isRefreshing };
}
