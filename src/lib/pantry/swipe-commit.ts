/**
 * One pointer drag's net displacement and duration, in the units
 * `PointerEvent` already reports — plain CSS px and milliseconds. Reduced
 * from a full `PointerEvent` so the decision is testable without touching
 * the DOM, the same split `fly-to-cart.ts`'s `FlightRect` draws for the
 * geometry it needs out of a `DOMRect`.
 */
export interface SwipeGesture {
  readonly dx: number;
  readonly dy: number;
  readonly elapsedMs: number;
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
 * Below this many px, a drag never commits, no matter how fast it moved —
 * without a floor, a fast but tiny jitter (a shaky finger lifting off the
 * card) would read as a flung swipe.
 */
const FLING_MIN_DISTANCE_PX = 24;

/**
 * Past this speed (px/ms), a shorter drag still commits — matches how a real
 * flick gesture feels: fast and short, not necessarily far.
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
 */
export function decideSwipeCommit(gesture: SwipeGesture): SwipeCommit {
  const { dx, dy, elapsedMs } = gesture;
  const distance = Math.abs(dx);

  if (distance < Math.abs(dy)) {
    return null;
  }

  const velocity = elapsedMs > 0 ? distance / elapsedMs : 0;
  const committedByDistance = distance >= DISTANCE_THRESHOLD_PX;
  const committedByFling =
    distance >= FLING_MIN_DISTANCE_PX && velocity >= FLING_VELOCITY_PX_PER_MS;

  if (!committedByDistance && !committedByFling) {
    return null;
  }

  return dx > 0 ? "have" : "ranOut";
}
