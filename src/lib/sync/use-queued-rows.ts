"use client";

import { useMutationState, type MutationKey } from "@tanstack/react-query";
import { useMemo } from "react";

import type { OrderedCartRow } from "@/lib/cart/receive-order";

import { queuedCartRowIds } from "./queued-mutations";

/**
 * Rows with a change sitting in the offline queue, for mockup 1c's 🕐 mark.
 *
 * The queue is not a structure this app owns — it is TanStack's mutation
 * cache, which is also what survives a reload through IndexedDB (task 2.4).
 * So the marks are *read* from that cache rather than tracked alongside it:
 * a mutation restored from storage after the PWA was killed lights its row up
 * exactly like one paused a second ago, with no bookkeeping to keep in sync.
 *
 * `cartPathKey` is `trpc.cart.pathKey()` — the same router-level key the
 * screen and the header already use for `useIsMutating`. TanStack matches
 * mutation keys by prefix, so it covers every `cart.*` mutation, including
 * `receiveOrder` (task 2.5).
 *
 * `items` is the cart's current rows — only `cart.receiveOrder` needs them
 * (it names a service, not a row; `queuedCartRowIds` resolves that against
 * what is currently `ordered`), so a caller with no cart data yet may simply
 * omit it.
 *
 * Every decision about *which* rows is in `queued-mutations.ts` (pure, and
 * therefore tested — vitest here runs in a node environment and cannot render
 * a hook).
 */
export function useQueuedCartRows(
  cartPathKey: MutationKey,
  items: readonly OrderedCartRow[] = [],
): ReadonlySet<string> {
  const queued = useMutationState({
    filters: { mutationKey: cartPathKey, status: "pending" },
    select: (mutation) => ({
      variables: mutation.state.variables,
      isPaused: mutation.state.isPaused,
    }),
  });

  // `useMutationState` runs its result through `replaceEqualDeep`, so this
  // array keeps its identity until a mutation actually changes — which is
  // what makes memoizing on it worthwhile rather than pointless.
  return useMemo(() => queuedCartRowIds(queued, items), [queued, items]);
}
