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
 * Which cart rows have a change waiting for the connection — mockup 1c's 🕐
 * «ждёт синхронизации» mark.
 *
 * **Paused only, never merely in flight.** A mutation that is on the wire
 * already shows up on its row as `data-pending` (task 2.3) and resolves in
 * milliseconds; 🕐 means "waiting for the connection", and putting it on
 * every ordinary tap would turn a signal about the network into a flicker
 * about the server.
 *
 * **`cart.add` marks nothing, on purpose.** The other three cart mutations
 * (`setStatus`, `updateItem`, `remove`) name an existing row by `id`; an add
 * names a *product*, and while it is queued there is no row on screen to mark
 * — the line it will create or merge into does not exist yet. Reading
 * `productId` here would mark whichever row happens to hold that product,
 * which is right only in the merge case and silently wrong in the other one.
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
    }
  }

  return ids;
}
