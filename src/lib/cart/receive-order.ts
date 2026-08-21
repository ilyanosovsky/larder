import type { OrderedVia } from "@/lib/ordered-via";
import type { CartItemStatus } from "@/server/cart/merge";

/**
 * «Заказ получен» (task 2.5) — the bulk half of the ordered flow: every
 * `ordered` row (or, narrowed by service, every row ordered through one of
 * them) moves to `bought` in one tap, instead of ticking each one by hand.
 *
 * Kept pure and shared between the optimistic patch, the rollback and the
 * offline queue's «waiting to sync» mark, for the same reason
 * `src/lib/cart/status-toggle.ts` is: the decision belongs in one place
 * `cart-item-sheet.tsx`, `cart-screen.tsx` and `queued-mutations.ts` can all
 * point at, rather than three copies quietly drifting apart.
 */

/** The fields a bulk receive needs from a row; a `cart.list` row satisfies it. */
export interface OrderedCartRow {
  id: string;
  status: CartItemStatus;
  orderedVia: OrderedVia | null;
}

/**
 * Whether `row` is one `cart.receiveOrder({ orderedVia })` would touch —
 * `undefined`/`null` means "every ordered row, whatever the service", the
 * same "no filter" reading `cart.receiveOrder`'s own input gives it.
 */
function isReceivable(
  row: Pick<OrderedCartRow, "status" | "orderedVia">,
  orderedVia: OrderedVia | null | undefined,
): boolean {
  if (row.status !== "ordered") {
    return false;
  }
  if (orderedVia === undefined || orderedVia === null) {
    return true;
  }
  return row.orderedVia === orderedVia;
}

/**
 * The ids a receive-order tap of this scope is about. Shared by the
 * optimistic patch below and `queued-mutations.ts`'s 🕐 mark, so the two can
 * never disagree about which rows a bulk receive touches.
 */
export function receivableRowIds<TRow extends OrderedCartRow>(
  items: readonly TRow[],
  orderedVia?: OrderedVia | null,
): string[] {
  return items
    .filter((row) => isReceivable(row, orderedVia))
    .map((row) => row.id);
}

/** One row's fields before `applyReceiveOrder` touched it — what a rollback restores. */
export interface ReceiveOrderSnapshot {
  id: string;
  status: CartItemStatus;
  orderedVia: OrderedVia | null;
}

export interface ReceiveOrderPatch<TRow> {
  list: TRow[];
  /** The rows actually touched, in case the request fails and needs undoing. */
  snapshots: ReceiveOrderSnapshot[];
}

/**
 * The optimistic half of «Заказ получен»: every receivable row moved to
 * `bought`, its `orderedVia` cleared — the badge disappears, matching the
 * orchestrator's decision to clear it on receive rather than keep it for
 * history.
 *
 * `buyerId` and `updatedAt` are deliberately left alone, for the same reason
 * `applyStatusToggle` leaves them alone for the single-row checkbox: the
 * server decides the buyer (the existing one kept, else the caller —
 * `cart.receiveOrder`'s own rule) and stamps the real timestamp, and guessing
 * either here would just have to be taken back the moment `onSettled`'s
 * invalidate lands. A stale `buyerId` for the handful of milliseconds until
 * then costs nothing a checkbox tap does not already cost.
 *
 * Returns `list` itself, same reference, when nothing matches — the common
 * case once a service's rows have already been received, and a fresh array
 * every render would be churn for nothing (same idea as `applyStatusToggle`).
 */
export function applyReceiveOrder<TRow extends OrderedCartRow>(
  list: TRow[],
  orderedVia?: OrderedVia | null,
): ReceiveOrderPatch<TRow> {
  if (!list.some((row) => isReceivable(row, orderedVia))) {
    return { list, snapshots: [] };
  }

  const snapshots: ReceiveOrderSnapshot[] = [];
  const nextList = list.map((row) => {
    if (!isReceivable(row, orderedVia)) {
      return row;
    }

    snapshots.push({
      id: row.id,
      status: row.status,
      orderedVia: row.orderedVia,
    });

    return { ...row, status: "bought" as const, orderedVia: null };
  });

  return { list: nextList, snapshots };
}

/**
 * Undoes `applyReceiveOrder` for exactly the rows a failed request touched —
 * the bulk analogue of `setStatus`'s per-row rollback (task 2.3): a snapshot
 * taken before this tap knows nothing about a checkbox ticked a moment later
 * on an unrelated row, so restoring anything wider would trample it.
 */
export function rollbackReceiveOrder<TRow extends OrderedCartRow>(
  list: TRow[],
  snapshots: readonly ReceiveOrderSnapshot[],
): TRow[] {
  if (snapshots.length === 0) {
    return list;
  }

  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  return list.map((row) => {
    const snapshot = byId.get(row.id);
    return snapshot === undefined
      ? row
      : { ...row, status: snapshot.status, orderedVia: snapshot.orderedVia };
  });
}

/** One service's worth of currently-ordered rows, for the «Заказ получен» bar. */
export interface OrderedServiceGroup {
  /** `null` covers an `ordered` row somehow left without a service on it. */
  orderedVia: OrderedVia | null;
  count: number;
}

/**
 * Fixed rather than first-appearance order, so the bar does not reshuffle
 * itself as rows move between services. `null` last: it is the fallback
 * bucket, not a service anyone picked.
 */
const SERVICE_GROUP_ORDER: readonly (OrderedVia | null)[] = [
  "wolt",
  "carrefour",
  "other",
  null,
];

/**
 * The distinct services among the cart's currently-`ordered` rows, one entry
 * per group with how many rows it holds — what the «Заказ получен · Wolt (3)»
 * bar renders one control per.
 */
export function groupOrderedByService<TRow extends OrderedCartRow>(
  items: readonly TRow[],
): OrderedServiceGroup[] {
  const counts = new Map<OrderedVia | null, number>();

  for (const item of items) {
    if (item.status !== "ordered") {
      continue;
    }
    counts.set(item.orderedVia, (counts.get(item.orderedVia) ?? 0) + 1);
  }

  return SERVICE_GROUP_ORDER.filter((service) => counts.has(service)).map(
    (service) => ({ orderedVia: service, count: counts.get(service) ?? 0 }),
  );
}

/** An {@link OrderedServiceGroup} narrowed to a real, receivable service. */
export interface ReceivableServiceGroup extends OrderedServiceGroup {
  orderedVia: OrderedVia;
}

/**
 * `groupOrderedByService`'s groups, minus the `null` one — the receive bar's
 * own filter, so a bulk «Заказ получен» button is never offered for it.
 *
 * `cart.receiveOrder({ orderedVia: null })` and an omitted `orderedVia` are
 * the *same* call server-side — both mean "every service" (the router's own
 * contract, `receiveOrderInput`). A row `ordered` with no service recorded is
 * therefore not a service `receiveOrder` can be scoped to on its own: tapping
 * a button for it would silently receive every other service's rows too,
 * which is not what tapping a button labelled for "no service" promises.
 *
 * Such a row cannot arise from anything this app's own UI writes today —
 * `CartItemSheet`'s service picker always supplies a concrete service
 * together with the `ordered` transition — but nothing in the type system
 * stops a future write path from leaving one, so the bar simply does not
 * offer a bulk action for it rather than risk over-scoping the request. The
 * row is not stranded: its own checkbox still buys it individually,
 * regardless of `orderedVia`.
 */
export function receivableServiceGroups(
  groups: readonly OrderedServiceGroup[],
): ReceivableServiceGroup[] {
  return groups.filter(
    (group): group is ReceivableServiceGroup => group.orderedVia !== null,
  );
}
