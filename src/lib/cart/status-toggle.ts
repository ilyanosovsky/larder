import type { CartItemStatus } from "@/server/cart/merge";

/**
 * What the row's checkbox means for a line currently in this status.
 *
 * Only two destinations, because the checkbox is a two-state control: an
 * unticked box buys the line, a ticked one puts it back. An `ordered` line —
 * on its way from Wolt, say — has an unticked box, so tapping it buys it, the
 * same as `needed`. That is the safe direction under last-write-wins
 * (VISION §3.1): the tap says "this is in the house now", which is true
 * whichever way the line got here. Nothing in 2.3 ever *sets* `ordered`;
 * that control arrives with task 2.5.
 */
export function toggledCartStatus(status: CartItemStatus): CartItemStatus {
  return status === "bought" ? "needed" : "bought";
}

/** The fields the optimistic patch needs; a `cart.list` row satisfies it. */
export interface TogglableCartRow {
  id: string;
  status: CartItemStatus;
}

/**
 * The optimistic half of the checkbox: the cached `cart.list` with one row's
 * status replaced, for `queryClient.setQueryData` inside `onMutate`.
 *
 * Two deliberate omissions, both so the screen tells the truth while the
 * request is in flight:
 *
 * - **`updatedAt` is left alone.** `useChangedRows` (`src/lib/sync/`) diffs
 *   snapshots on that timestamp, and the «мягкая подсветка» it drives means
 *   "your partner changed this" — moving it here would make the app flash a
 *   highlight at you for your own tap.
 * - **`buyerId` is left alone.** The server stamps the caller as the buyer on
 *   `bought` and clears it on `needed`; guessing that here would render a
 *   «кто берёт» that a failed request then has to take back. The invalidate in
 *   `onSettled` brings the real value.
 *
 * Returns `list` itself when no row carries that id — a row a refetch removed
 * out from under the tap is a genuine no-op, not an empty rewrite of the
 * cache.
 */
export function applyStatusToggle<TRow extends TogglableCartRow>(
  list: TRow[],
  id: string,
  status: CartItemStatus,
): TRow[] {
  if (!list.some((row) => row.id === id)) {
    return list;
  }

  return list.map((row) => (row.id === id ? { ...row, status } : row));
}
