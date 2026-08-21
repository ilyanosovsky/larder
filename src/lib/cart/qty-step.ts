import { MAX_QTY } from "@/server/cart/merge";

/**
 * The stepper's own floor — one whole unit, not the router's `MIN_QTY`.
 *
 * `MIN_QTY` (0.001) is what the `numeric(10, 3)` column can hold without
 * rounding down to nothing; it is a storage bound, not an offer. A «−» button
 * that walked 1 → 0.999 would be absurd at the shelf, so the stepper stops at
 * 1 and disables the control there. Fractional quantities («0.5 кг») are typed
 * rather than stepped, and that editor is task 2.5.
 */
export const STEPPER_MIN_QTY = 1;

/** The ceiling `cart.add` itself enforces — the stepper never offers more. */
export const STEPPER_MAX_QTY = MAX_QTY;

/** One tap of «−» / «+». */
export const QTY_STEP = 1;

/**
 * Clamps a quantity into what the stepper — and therefore `addCartItemInput` —
 * will accept.
 *
 * `NaN` is handled explicitly because `Math.min`/`Math.max` propagate it
 * rather than clamping it, and a `NaN` reaching `cart.add` comes back as a
 * validation error nobody at the shelf can act on. Infinities need no such
 * guard: they clamp to the nearer bound like any other out-of-range number.
 */
export function clampQty(value: number): number {
  if (Number.isNaN(value)) {
    return STEPPER_MIN_QTY;
  }
  return Math.min(Math.max(value, STEPPER_MIN_QTY), STEPPER_MAX_QTY);
}

/** One «−»/«+» tap: `delta` applied, then clamped. */
export function stepQty(current: number, delta: number): number {
  return clampQty(current + delta);
}

/** Whether «−» / «+» have anywhere left to go, for `disabled`. */
export function canStepQty(current: number, delta: number): boolean {
  return stepQty(current, delta) !== clampQty(current);
}
