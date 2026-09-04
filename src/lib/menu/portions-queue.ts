/**
 * The S10 card's write ledger: **at most one write per row is ever
 * outstanding**, and taps made while it is in flight only move the intent.
 *
 * Two separate requests for one card can be served out of order, and both
 * `menu.setPortions` and `menu.setCooked` are last-write-wins `UPDATE`s with
 * no expected-state predicate — so the earlier tap could be the one that
 * persists, and the invalidating refetch would then snap the card back to a
 * value the user already moved past. Serialising per row removes the race
 * without a timer: the first tap of a run writes immediately, every tap
 * during it moves `asked`, and `settleWrite` dispatches one follow-up
 * carrying the final value.
 *
 * **Coalescing, not debouncing** (D18). Nothing waits on a clock, so nothing
 * can be swallowed by a timer that never fired — the lost-write class the
 * repo documents (navigate away, background the PWA, drop the connection
 * inside the window and the tap is gone with no pending state on screen).
 *
 * Pure and generic over the value because the ± writes a number and the
 * «приготовлено» checkbox writes a boolean, and the ordering problem is
 * identical; `menu-screen.tsx` keeps one ledger per mutation in one ref each.
 * It lives here rather than in the `.tsx` for the reason every branch in this
 * app does: vitest runs in `node` with no DOM harness, so a state machine
 * inside a component is unreachable from the suite and a flipped branch ships
 * green.
 */

/**
 * One mutation's ledger, keyed by row id.
 *
 * `asked` is what that row's last tap wanted, `inFlight` what is currently on
 * the wire for it, and `baseline` what to put back if the run fails — the
 * value the row showed before the run began, advanced to every number the
 * server has since acknowledged.
 *
 * Mutable and held in a single `useRef`: the render cannot answer either
 * question in time. `onMutate` opens with an awaited `cancelQueries`, so the
 * optimistic patch — and the re-render carrying it — lands milliseconds after
 * `mutate()` returns, and two taps inside that window would both read the
 * rendered row.
 */
export interface WriteQueue<TValue> {
  asked: Map<string, TValue>;
  inFlight: Map<string, TValue>;
  baseline: Map<string, TValue>;
}

export function createWriteQueue<TValue>(): WriteQueue<TValue> {
  return { asked: new Map(), inFlight: new Map(), baseline: new Map() };
}

/** What a tap decided. `null` means «nothing to do». */
export interface QueuedWrite<TValue> {
  /** The value the row must show now, patched into the cache synchronously. */
  patch: TValue | null;
  /** The write to dispatch now, or `null` when it coalesced into the one in flight. */
  send: TValue | null;
}

/** What the settled write decided. */
export interface SettledWrite<TValue> {
  /** The value to patch back after a failure; `null` when there is nothing to undo. */
  rollbackTo: TValue | null;
  /**
   * The single follow-up carrying everything tapped during the round trip.
   *
   * `null` means the run is over, so the caller invalidates rather than
   * waiting — the one fact both call sites branch on, which is why there is
   * no separate `done` flag saying the same thing twice.
   */
  send: TValue | null;
}

/**
 * Records a tap and says what to do with it.
 *
 * `current` is what the row shows *now* — used only to open a run's baseline,
 * because during a run the freshest intent is `asked`, not the rendered value
 * (a cancelled refetch may have restored the server's older number under it).
 */
export function queueWrite<TValue>(
  queue: WriteQueue<TValue>,
  id: string,
  current: TValue,
  next: TValue,
): QueuedWrite<TValue> {
  if (!queue.baseline.has(id)) {
    queue.baseline.set(id, current);
  }
  queue.asked.set(id, next);

  if (queue.inFlight.has(id)) {
    // Coalesced: the value still has to move under the finger, so it is
    // patched, but nothing is dispatched until the outstanding write settles.
    return { patch: next, send: null };
  }

  queue.inFlight.set(id, next);
  return { patch: next, send: next };
}

/**
 * Closes one round trip: rolls back on failure, or dispatches the one
 * follow-up the taps made during it are owed.
 *
 * Called from `onSettled` rather than split across `onError`/`onSettled`, so
 * the three maps are mutated in exactly one place and in one order.
 *
 * **The baseline advances on every acknowledged write.** Without it, a first
 * write that succeeded and a follow-up that then failed would roll the row
 * back past a value the server is already holding — and when the failure is a
 * dropped connection the invalidating refetch cannot correct it either, so
 * the row would keep showing the stale pre-run value until the next reconnect.
 */
export function settleWrite<TValue>(
  queue: WriteQueue<TValue>,
  id: string,
  sent: TValue,
  ok: boolean,
): SettledWrite<TValue> {
  queue.inFlight.delete(id);

  if (ok) {
    queue.baseline.set(id, sent);

    const asked = queue.asked.get(id);
    if (asked !== undefined && asked !== sent) {
      queue.inFlight.set(id, asked);
      return { rollbackTo: null, send: asked };
    }
  }

  const rollbackTo = ok ? null : (queue.baseline.get(id) ?? null);
  forgetWrite(queue, id);

  return { rollbackTo, send: null };
}

/** Drops every ledger entry for a row once its run of taps is over. */
export function forgetWrite<TValue>(
  queue: WriteQueue<TValue>,
  id: string,
): void {
  queue.asked.delete(id);
  queue.inFlight.delete(id);
  queue.baseline.delete(id);
}

/** The ± control's bounds, as `portionsRange(portionsBase)` returns them. */
export interface PortionsBounds {
  min: number;
  max: number;
}

/**
 * Where one «−»/«+» tap lands, or `null` when the button has nowhere to go.
 *
 * The ordinary case is a clamp into `bounds`. The case worth spelling out is
 * a row **outside** them: `portions` is joined live from `recipes`, and
 * `dish.update` can lower a recipe's yield without touching `menu_items` —
 * deliberately, because the server must not re-clamp a number it accepted
 * last week (`addMenuItemInput`'s own comment). So a card can legitimately
 * show 20 portions under a range of 1…12.
 *
 * From there:
 * - «+» is refused. It is `aria-disabled` on screen, and a clamp that ignored
 *   the direction of the tap would make it *lower* the number — 20 → 12 — on
 *   a button whose only meaning is «больше».
 * - «−» steps by one, 20 → 19, rather than jumping to 12. A single tap must
 *   not silently discard eight portions of shopping; walking back is what the
 *   control offers everywhere else, and the range is reached eventually.
 *
 * Both fall out of one rule: the window a tap may land in is `bounds` widened
 * to wherever the row actually stands, and a move against the tap's own
 * direction is not a move.
 */
export function stepPortions(
  from: number,
  delta: number,
  bounds: PortionsBounds,
): number | null {
  const ceiling = Math.max(bounds.max, from);
  const floor = Math.min(bounds.min, from);
  const next = Math.min(ceiling, Math.max(floor, from + delta));

  return Math.sign(next - from) === Math.sign(delta) ? next : null;
}

/**
 * One ± tap, end to end: the step rule above, then the ledger.
 *
 * `current` is the number on the card; the run's own intent (`asked`) wins
 * over it while a run is open, because a tap made during the awaited
 * `cancelQueries` has already moved it on.
 */
export function tapPortions(
  queue: WriteQueue<number>,
  id: string,
  current: number,
  delta: number,
  bounds: PortionsBounds,
): QueuedWrite<number> {
  const from = queue.asked.get(id) ?? current;
  const next = stepPortions(from, delta, bounds);

  if (next === null) {
    return { patch: null, send: null };
  }

  return queueWrite(queue, id, current, next);
}
