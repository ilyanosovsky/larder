/**
 * One pointer drag's displacement and recent-window velocity, in the units
 * `PointerEvent` already reports — plain CSS px and milliseconds. Reduced
 * from a full `PointerEvent` so the decision is testable without touching
 * the DOM, the same split `fly-to-cart.ts`'s `FlightRect` draws for the
 * geometry it needs out of a `DOMRect`.
 *
 * `dx`/`dy` are the **total** displacement since the drag began — what the
 * distance threshold (a deliberate, unhurried drag) is measured against.
 * `recentDx`/`recentElapsedMs` are displacement and elapsed time over only
 * the *most recent* window of movement (see `revision-mode.tsx`'s own
 * `VELOCITY_WINDOW_MS`) — deliberately **not** the same span `dx`/`dy` cover.
 * A gesture that holds still for a while and then flings at the very end
 * must read as fast: averaging the fling's speed over the whole
 * press-hold-then-flick (using the total elapsed time since the drag
 * started) would dilute a genuinely fast release into a slow one, since most
 * of that elapsed time was spent not moving at all.
 */
export interface SwipeGesture {
  readonly dx: number;
  readonly dy: number;
  readonly recentDx: number;
  readonly recentElapsedMs: number;
}

export type SwipeCommit = "have" | "ranOut" | null;

/**
 * Past this many px, a drag commits on distance alone regardless of how
 * slowly it got there. DESIGN_BRIEF's "swipe right = «есть», left =
 * «кончилось»" reads as a deliberate, unhurried gesture as often as a quick
 * flick, and a distance-only floor keeps a slow, controlled drag from ever
 * springing back on the shopper just because it wasn't fast.
 */
const DISTANCE_THRESHOLD_PX = 96;

/**
 * Below this many px of *recent* movement, a drag never commits on velocity
 * alone, no matter how fast that movement was — without a floor, a fast but
 * tiny jitter (a shaky finger lifting off the card) would read as a flung
 * swipe. Compared against `recentDx`, not the drag's total `dx`.
 */
const FLING_MIN_DISTANCE_PX = 24;

/**
 * Past this speed (px/ms), a shorter recent movement still commits — matches
 * how a real flick gesture feels: fast and short, not necessarily far.
 * Computed from `recentDx`/`recentElapsedMs`, not the drag's full duration.
 */
const FLING_VELOCITY_PX_PER_MS = 0.5;

/**
 * Turns one released drag into a swipe decision, or `null` for "spring back,
 * nothing decided" — the pure half of the S5 revision mode's swipe mechanics
 * (DESIGN_BRIEF), so the threshold math is unit-tested without a pointer or
 * a DOM.
 *
 * **A drag that moved more vertically than horizontally never commits**,
 * regardless of `dx`'s own magnitude. There is no vertical gesture of its
 * own to conflict with here — one card fills the screen, nothing to scroll —
 * but treating a wandering, not-really-horizontal drag as a confident
 * left/right choice would let an accidental touch commit a decision the
 * shopper never meant to make.
 *
 * **The committed direction always comes from the total `dx`, never
 * `recentDx`.** `recentDx`/`recentElapsedMs` only ever decide *whether* the
 * fling threshold is met; the card visually ends up on whichever side the
 * drag was actually released toward, matching what the shopper sees on
 * screen at the moment of release.
 */
export function decideSwipeCommit(gesture: SwipeGesture): SwipeCommit {
  const { dx, dy, recentDx, recentElapsedMs } = gesture;
  const distance = Math.abs(dx);

  if (distance < Math.abs(dy)) {
    return null;
  }

  const recentDistance = Math.abs(recentDx);
  const velocity = recentElapsedMs > 0 ? recentDistance / recentElapsedMs : 0;
  const committedByDistance = distance >= DISTANCE_THRESHOLD_PX;
  const committedByFling =
    recentDistance >= FLING_MIN_DISTANCE_PX &&
    velocity >= FLING_VELOCITY_PX_PER_MS;

  if (!committedByDistance && !committedByFling) {
    return null;
  }

  return dx > 0 ? "have" : "ranOut";
}
