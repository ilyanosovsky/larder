/**
 * A queued `cart.*` mutation, reduced to the three fields the 🕐 mark needs.
 * `useQueuedCartRows` builds these from the mutation cache; the extraction
 * below is pure so it can be tested without one.
 */
export interface QueuedCartMutation {
  /** The mutation's input, exactly as the call site passed it. */
  readonly variables: unknown;
  /** TanStack's own flag: dispatched, but held back because we are offline. */
  readonly isPaused: boolean;
  /**
   * Whatever `onMutate` returned — `mutation.state.context`. `cart.
   * receiveOrder`'s own row ids are read from here rather than re-derived
   * from the current cart list: by the time anything downstream of the
   * mutation cache looks, `onMutate`'s own optimistic patch has already
   * moved every affected row out of the `ordered` status that would
   * otherwise identify it, so resolving against live data would find
   * nothing to mark, every time. `dehydrateMutation` persists the whole
   * `state` object, `context` included, so this also holds for a mutation
   * restored from IndexedDB after a reload.
   */
  readonly context?: unknown;
}

/** Narrows an unknown value to something with string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `cart.receiveOrder`'s own row ids, read out of its `onMutate` context
 * (`{ snapshots: [{ id, ... }] }` — see `applyReceiveOrder` in
 * `src/lib/cart/receive-order.ts`). Treated as untrusted the same way
 * `variables` is: it round-trips through IndexedDB/superjson for a restored
 * mutation, so a malformed entry is simply skipped rather than trusted.
 */
function receiveOrderContextRowIds(context: unknown): string[] {
  if (!isRecord(context) || !Array.isArray(context.snapshots)) {
    return [];
  }

  const ids: string[] = [];
  for (const snapshot of context.snapshots) {
    if (
      isRecord(snapshot) &&
      typeof snapshot.id === "string" &&
      snapshot.id !== ""
    ) {
      ids.push(snapshot.id);
    }
  }
  return ids;
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
 * **`cart.receiveOrder` (task 2.5) names a whole service, not a row**, and is
 * the one shape left once `id` and `productId` are ruled out. Its rows come
 * from its own `onMutate` context (`receiveOrderContextRowIds`) rather than
 * from a live cart snapshot — see that function's doc comment for why
 * resolving against current data cannot work here.
 *
 * Variables are treated as untrusted shapes rather than as the router's input
 * types: they can also come back from IndexedDB, written by an older version
 * of the app.
 */
export function queuedCartRowIds(
  mutations: readonly QueuedCartMutation[],
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

    if ("productId" in mutation.variables) {
      // cart.add — no row on screen to mark yet.
      continue;
    }

    for (const rowId of receiveOrderContextRowIds(mutation.context)) {
      ids.add(rowId);
    }
  }

  return ids;
}
