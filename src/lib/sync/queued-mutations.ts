import {
  receivableRowIds,
  type OrderedCartRow,
} from "@/lib/cart/receive-order";
import { orderedViaSchema, type OrderedVia } from "@/lib/ordered-via";

/**
 * A queued `cart.*` mutation, reduced to the two fields the 🕐 mark needs.
 * `useQueuedCartRows` builds these from the mutation cache; the extraction
 * below is pure so it can be tested without one.
 */
export interface QueuedCartMutation {
  /** The mutation's input, exactly as the call site passed it. */
  readonly variables: unknown;
  /** TanStack's own flag: dispatched, but held back because we are offline. */
  readonly isPaused: boolean;
}

/** Narrows an unknown value to something with string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads a `cart.receiveOrder` filter out of untrusted variables, or reports
 * that the shape belongs to a different mutation.
 *
 * `receiveOrder`'s input is the one cart mutation with **no row id and no
 * product id** — `{ orderedVia? }`, everything optional — so that absence is
 * what identifies it here, the same "read the shape, not the router's types"
 * approach `queuedCartRowIds` already takes for the other three. An
 * `orderedVia` that fails to parse is treated as "not this mutation" rather
 * than guessed at: a garbage value from an older build marking rows on a
 * wrong assumption is worse than marking none.
 */
function receiveOrderFilter(
  value: Record<string, unknown>,
):
  | { matched: true; orderedVia: OrderedVia | null | undefined }
  | { matched: false } {
  if ("id" in value || "productId" in value) {
    return { matched: false };
  }

  const raw = value.orderedVia;
  if (raw === undefined || raw === null) {
    return { matched: true, orderedVia: raw };
  }

  const parsed = orderedViaSchema.safeParse(raw);
  return parsed.success
    ? { matched: true, orderedVia: parsed.data }
    : { matched: false };
}

/**
 * Which cart rows have a change waiting for the connection — mockup 1c's 🕐
 * «ждёт синхронизации» mark.
 *
 * **Paused only, never merely in flight.** A mutation that is on the wire
 * already shows up on its row as `data-pending` (task 2.3) and resolves in
 * milliseconds; 🕐 means "waiting for the connection", and putting it on
 * every ordinary tap would turn a signal about the network into a flicker
 * about the server.
 *
 * **`cart.add` marks nothing, on purpose.** The other cart mutations that
 * name an existing row by `id` (`setStatus`, `updateItem`, `remove`) mark it
 * directly; an add names a *product*, and while it is queued there is no row
 * on screen to mark — the line it will create or merge into does not exist
 * yet. Reading `productId` here would mark whichever row happens to hold
 * that product, which is right only in the merge case and silently wrong in
 * the other one.
 *
 * **`cart.receiveOrder` (task 2.5) names a whole service, not a row.** It
 * marks every row `items` currently shows as `ordered` — narrowed to one
 * service when the queued call named one — via `receivableRowIds`, the same
 * pure rule the optimistic patch and the router itself use to decide what a
 * receive touches. `items` is optional and defaults to nothing: a caller that
 * has no cart data yet (or does not care about this mutation) simply marks no
 * row for it, same as before this mutation existed.
 *
 * Variables are treated as untrusted shapes rather than as the router's input
 * types: they can also come back from IndexedDB, written by an older version
 * of the app.
 */
export function queuedCartRowIds(
  mutations: readonly QueuedCartMutation[],
  items: readonly OrderedCartRow[] = [],
): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const mutation of mutations) {
    if (!mutation.isPaused || !isRecord(mutation.variables)) {
      continue;
    }

    const id = mutation.variables.id;
    if (typeof id === "string" && id !== "") {
      ids.add(id);
      continue;
    }

    const receive = receiveOrderFilter(mutation.variables);
    if (receive.matched) {
      for (const rowId of receivableRowIds(items, receive.orderedVia)) {
        ids.add(rowId);
      }
    }
  }

  return ids;
}
