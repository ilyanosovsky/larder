"use client";

import { useQueryClient, type QueryFilters } from "@tanstack/react-query";
import { useCallback, useState } from "react";

export interface ManualRefresh {
  /** Awaits `queryClient.refetchQueries(filter)`. Safe to call again while
   * already refreshing — TanStack Query dedupes overlapping fetches of the
   * same query. */
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
 * A thin shell over `refetchQueries` plus an `isRefreshing` flag: there is no
 * branching for a pure helper to own, since `refetchQueries` already
 * resolves once every matching query has settled, success or error alike.
 */
export function useManualRefresh(filter: QueryFilters): ManualRefresh {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await queryClient.refetchQueries(filter);
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, filter]);

  return { refresh, isRefreshing };
}
