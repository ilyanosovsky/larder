import { MAX_QTY, MIN_QTY, roundQty } from "@/server/cart/merge";
import type { Unit } from "@/lib/units";

/**
 * The S4 stepper's arithmetic (mockup #1g) and the row editor's parsing
 * rules (task 2.5) — everything that decides *what number* the qty field
 * shows next, kept out of `qty-stepper.tsx` so vitest (node, no DOM) can
 * cover every branch directly.
 *
 * Bug fixed here (user report, 2026-09-04): the stepper used to offer a
 * single global step of 1 for every unit, so buying «250 г» meant 250 taps
 * of «+». The fix has two independent halves:
 *
 * - **Typing** (`parseTypedQty`) — a shopper who knows the number should
 *   never have to tap for it.
 * - **Stepping** (`stepQty`) — a tap should still move by an amount that
 *   makes sense for the unit: whole pieces for «шт», half-kilos for «кг».
 *
 * The two halves have different bounds on purpose. Typing accepts anything
 * `addCartItemInput`/`updateCartItemInput` would (`[MIN_QTY, MAX_QTY]`,
 * fractional, below one step — «0,3 кг» is a real quantity someone might
 * type). Stepping never offers something a shopper did not ask for: its
 * floor is one whole step of the unit, never the storage minimum.
 */

/**
 * One tap of «−»/«+», per unit (VISION §3.1's unit list, task Б4).
 *
 * «шт»-shaped units (also «уп», «пучок», «банка», «плитка») are always
 * bought as whole items, so their step is 1 — unchanged from before this
 * fix. The by-weight/by-volume units get a step worth actually walking to:
 * 50 g/ml is a shelf-realistic increment, half a kilo/litre likewise. These
 * are a product proposal, not a physical law — if a future household wants
 * a different grid, this is the one table to edit.
 */
export const QTY_STEP_BY_UNIT: Record<Unit, number> = {
  шт: 1,
  уп: 1,
  пучок: 1,
  банка: 1,
  плитка: 1,
  г: 50,
  кг: 0.5,
  мл: 50,
  л: 0.5,
};

/** One «−»/«+» tap's size for `unit`. Also `unit`'s stepper floor — see `stepQty`. */
export function qtyStepFor(unit: Unit): number {
  return QTY_STEP_BY_UNIT[unit];
}

/**
 * The quantity a fresh line opens with, before anyone has touched the
 * stepper — S4's «Сколько нужно?» and the row editor both start here.
 *
 * Whole-item units open at 1, same as `qtyStepFor` for them. The
 * by-weight/by-volume units open at a round, shelf-sized amount (100 g/ml,
 * 1 kg/l) rather than at their own *step* (50 g would make the very first
 * screen look like someone already tapped «+» once for no reason).
 */
const DEFAULT_QTY_BY_UNIT: Record<Unit, number> = {
  шт: 1,
  уп: 1,
  пучок: 1,
  банка: 1,
  плитка: 1,
  г: 100,
  кг: 1,
  мл: 100,
  л: 1,
};

/** The value a fresh qty/unit line opens with, for `unit`. */
export function defaultQtyFor(unit: Unit): number {
  return DEFAULT_QTY_BY_UNIT[unit];
}

/** Units bought as whole items — typed values round to the nearest integer, not to `roundQty`'s 3 decimals. */
const DISCRETE_UNITS: ReadonlySet<Unit> = new Set([
  "шт",
  "уп",
  "пучок",
  "банка",
  "плитка",
]);

/**
 * The ceiling the stepper — and `addCartItemInput`/`updateCartItemInput` —
 * will accept. Kept as its own name (rather than importing `MAX_QTY`
 * everywhere) so a reader of `qty-stepper.tsx` sees "the stepper's own
 * ceiling" without having to know it happens to equal the router's.
 */
export const STEPPER_MAX_QTY = MAX_QTY;

/**
 * Grid arithmetic done in integer "milli-units" (matching `numeric(10, 3)`'s
 * own scale) rather than in floating point directly. `100 / 0.5` is exact in
 * binary, but not every unit/quantity pair is guaranteed to be, and a
 * `Math.floor` one ULP off would snap to the wrong grid line right at a
 * boundary — exactly where this function is asked to be precise.
 */
const GRID_SCALE = 1000;

function toGridUnits(value: number): number {
  return Math.round(value * GRID_SCALE);
}

/**
 * One «−»/«+» tap: moves `current` to the next point on `unit`'s step grid
 * in the direction of `delta`'s sign (the magnitude of `delta` is not used —
 * the unit decides how big a step is now, not the caller).
 *
 * Snaps rather than adds outright, because `current` may not be on the grid
 * at all: a typed «30 г» is a real value the stepper has to start stepping
 * *from*, not a value it can pretend is a multiple of 50. So:
 *
 * - «+» moves to the nearest grid point **above** `current` — for an
 *   on-grid value that is exactly one step on; for an off-grid one (30 г) it
 *   is the grid line it was already short of (30 → 50, not 30 → 80).
 * - «−» moves to the nearest grid point **below** `current`, floored at one
 *   whole step (never 0 — see `canStepQty` for when this makes «−» a no-op
 *   and therefore disabled). A value *already below* the floor (30 г, whose
 *   floor is 50 г) is returned **unchanged** — there is nowhere lower on the
 *   grid to go, and snapping it *up* to the floor would make «−», labelled
 *   «Уменьшить количество», raise the value: the same number «+» would have
 *   reached, with no way back to the sub-floor value except retyping it.
 *   Leaving it unchanged is what lets `canStepQty` report "nothing to do"
 *   here and disable the control instead.
 *
 * The result is always rounded with `roundQty`, so it is a number
 * `cart_items.qty` can actually hold.
 */
export function stepQty(current: number, delta: number, unit: Unit): number {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const step = qtyStepFor(unit);
  const floor = step;

  const stepUnits = toGridUnits(step);
  const currentUnits = toGridUnits(safeCurrent);

  if (delta > 0) {
    const nextUnits = (Math.floor(currentUnits / stepUnits) + 1) * stepUnits;
    return roundQty(Math.min(nextUnits / GRID_SCALE, MAX_QTY));
  }

  if (currentUnits < stepUnits) {
    return roundQty(safeCurrent);
  }

  const prevUnits = (Math.ceil(currentUnits / stepUnits) - 1) * stepUnits;
  const flooredUnits = Math.max(prevUnits, stepUnits);
  return roundQty(Math.max(flooredUnits / GRID_SCALE, floor));
}

/** Whether «−» / «+» would actually change the value, for `disabled`. */
export function canStepQty(
  current: number,
  delta: number,
  unit: Unit,
): boolean {
  return stepQty(current, delta, unit) !== roundQty(current);
}

/**
 * A typed quantity, or `null` for anything the field should reject and
 * revert rather than pass on to `onQtyChange`.
 *
 * Accepts what a shopper actually types on a phone: a plain integer
 * («250»), a decimal with either separator («0,5» — the on-screen decimal
 * keyboard's own key — or «0.5»), and Cyrillic-keyboard-friendly thousands
 * grouping with a space («1 500»). Rejects empty input, anything that is
 * not a non-negative plain number after that normalization (no leading
 * sign, no exponents, no double separators), and anything that rounds down
 * to zero or below.
 *
 * Deliberately **not** clamped to `qtyStepFor(unit)`'s grid or floor — a
 * typed value may sit anywhere between the router's own bounds, including
 * below one step and fractional (task Б4: «0,3 кг» is a real quantity a
 * shopper can want, the same way the stepper's own «+»/«−» must not offer
 * it). It *is* rounded per `unit`'s own shape: a «шт»-like unit is bought in
 * whole items, so a typed «2,5 шт» rounds to the nearest integer (3) rather
 * than being accepted as a fraction of a physical thing the shopper cannot
 * actually hand over at the register.
 */
export function parseTypedQty(text: string, unit: Unit): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Strips Russian thousands grouping («1 500») and accepts either decimal
  // separator the on-screen numeric keyboard offers.
  const normalized = trimmed.replace(/\s+/g, "").replace(",", ".");

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const rounded = DISCRETE_UNITS.has(unit)
    ? Math.round(value)
    : roundQty(value);
  if (rounded <= 0) {
    return null;
  }

  return Math.min(Math.max(rounded, MIN_QTY), MAX_QTY);
}

/**
 * What the quantity should become when the unit changes (S4's unit select,
 * the row editor's own).
 *
 * `current === defaultQtyFor(fromUnit)` is read as "nobody has touched this
 * field yet" — the line is still showing the default it opened with, so the
 * new unit's own default is the more honest number to show (switching a
 * fresh «100 г» line to «кг» should read «1 кг», not «100 кг»). Anything
 * else is a number the shopper put there on purpose — by typing, or by
 * tapping «+»/«−» — and switching units must never silently reinterpret it:
 * someone who typed «250» meant 250 of *something*, and rescaling it behind
 * their back (into 250 g worth of kilos, say) would be a guess this module
 * has no basis for. The number survives the unit change unchanged; the
 * shopper corrects it themselves if the unit switch means it no longer
 * applies.
 */
export function qtyForUnitChange(
  current: number,
  fromUnit: Unit,
  toUnit: Unit,
): number {
  if (fromUnit === toUnit) {
    return current;
  }
  return current === defaultQtyFor(fromUnit) ? defaultQtyFor(toUnit) : current;
}

/**
 * Formats a Russian number without grouping — «1000», not «1 000», «0,5»
 * not «0.5». The one place this rule lives: `formatRecipeQty`
 * (`src/lib/recipes/rescale.ts`) imports this rather than keeping its own
 * copy, so the stepper's editable field and a recipe's rendered quantity can
 * never quietly disagree about how the same number looks.
 */
export function formatQtyNumber(value: number): string {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}
