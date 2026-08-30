/** The subset of `DOMRect` the geometry needs — plain numbers, no DOM. */
export interface FlightRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FlightDelta {
  /** Where the ghost's own top-left is planted — `from`'s, unchanged. */
  readonly left: number;
  readonly top: number;
  /** The CSS `translate()` that lands the ghost's centre on `to`'s centre. */
  readonly dx: number;
  readonly dy: number;
}

/**
 * The «Кончилось» fly-over's geometry (DESIGN_BRIEF S5; §6 calls this the
 * single place in the app with pronounced motion) — pure so the arithmetic
 * is unit-tested without a DOM, the same split `src/lib/sync/` and
 * `src/lib/cart/` use throughout for anything that would otherwise need a
 * render to exercise.
 *
 * **Centre-to-centre, not corner-to-corner.** The ghost is a compact
 * icon+name chip planted at `from`'s top-left, not a resize of the row's own
 * box into the segment control's — a translate that aligned the two rects'
 * corners would fly the chip toward a point that reads as "the tab's edge",
 * not "the tab". Centres read as "landed on the target" regardless of how
 * the two rects' sizes differ.
 */
export function flyToCartDelta(from: FlightRect, to: FlightRect): FlightDelta {
  const fromCenterX = from.left + from.width / 2;
  const fromCenterY = from.top + from.height / 2;
  const toCenterX = to.left + to.width / 2;
  const toCenterY = to.top + to.height / 2;

  return {
    left: from.left,
    top: from.top,
    dx: toCenterX - fromCenterX,
    dy: toCenterY - fromCenterY,
  };
}
