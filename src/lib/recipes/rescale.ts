import { MIN_QTY, roundQty } from "@/server/cart/merge";

/**
 * Portion rescaling and quantity rendering for S7 (DESIGN_BRIEF S7: «285 г»,
 * «¾ ч.л.», «½ ч.л.»).
 *
 * Pure and shared: the portions slider (task 4.5) drags over `rescaleQty`,
 * and every ingredient row on S7 renders through `formatRecipeQty`, so a
 * dragged value and a stored value are formatted by exactly one function.
 */

/**
 * The vulgar fractions a recipe actually states, largest denominator first is
 * irrelevant — what matters is that a cook reads «¾ ч.л.», not «0,75 ч.л.».
 * Anything outside this set falls back to a decimal rather than being nudged
 * onto the nearest glyph: «0,4 л» is honest, «⅓ л» would be a lie.
 */
const FRACTION_GLYPHS: ReadonlyArray<readonly [number, string]> = [
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
];

/**
 * How far a fractional part may sit from a glyph's exact value and still be
 * rendered as that glyph. Wide enough for the 3-decimal storage scale (0.333
 * and 0.667 are what `numeric(10, 3)` holds for a third and two thirds),
 * narrow enough that 0.3 and 0.7 stay decimals.
 */
const FRACTION_TOLERANCE = 0.005;

/**
 * What a missing — or vanishingly small — quantity looks like. A typographic
 * placeholder, not copy: it stands in the column where a number would be, the
 * same way the «·» separators in the design's own rows do.
 */
const NO_QUANTITY = "—";

/**
 * The bounds task 4.5's slider drags between: never below one portion, and
 * always able to reach `base` itself plus room to double it — a household
 * cooking «Шакшука» (`base = 2`) still gets a slider that goes past 4, not one
 * that caps out exactly where it started.
 *
 * `Math.max(12, base * 2)` rather than a flat ceiling: a batch recipe already
 * stated for 12 (a cookie tray) is not artificially capped at its own base,
 * and a two-portion recipe is not stuck offering only up to 4.
 */
export function portionsRange(base: number): { min: number; max: number } {
  return { min: 1, max: Math.max(12, base * 2) };
}

/**
 * The stated quantity, rescaled from `base` portions to `portions`.
 *
 * `portions === base` returns the caller's own value untouched, before any
 * arithmetic. At the storage scale this is only a fast path — `roundQty`
 * erases every difference `(qty * base) / base` could introduce for an
 * integer `portions_base` — but it is a real guarantee outside it: a value
 * that never came from the column (0.1 + 0.2, say) comes back bit-identical
 * rather than rounded to three decimals. S7 opens on `portionsBase`, so this
 * is the path every unmoved slider takes.
 *
 * Rounded with the cart's own `roundQty`, so the number the slider shows is a
 * number `numeric(10, 3)` can hold and phase 5.2 can sum without rounding it
 * a second time.
 *
 * The result is **not clamped**: a quantity that scales below the storage
 * floor comes back as the small number it is, and `formatRecipeQty` renders
 * it as «—» rather than a confident «0» (5.2 clamps before it writes a cart
 * row). Clamping here would invent a quantity the recipe never stated.
 */
export function rescaleQty(
  qty: number | null,
  portions: number,
  base: number,
): number | null {
  if (qty === null) {
    return null;
  }

  // A base of zero (or a corrupt row) would produce Infinity/NaN; leaving the
  // stated quantity alone is the only honest answer, and S7 still renders it.
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(portions)) {
    return qty;
  }

  if (portions === base) {
    return qty;
  }

  return roundQty((qty * portions) / base);
}

/**
 * Formats a Russian number without grouping — «1000», not «1 000».
 *
 * The locale is named rather than inherited: the app ships a single locale
 * (`src/i18n/request.ts`), and a decimal comma that depended on the ambient
 * environment would differ between the server render and the browser.
 * Grouping is off because a recipe quantity is never large enough to need it,
 * and the separator is a non-breaking space that only costs layout.
 */
function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}

/**
 * «285 г» · «¾ ч.л.» · «1½» · «2 шт» · «—».
 *
 * The unit is rendered verbatim because a unit **is data**, not copy: it is a
 * stored `RECIPE_UNITS` value, exactly as the cart already renders `UNITS`.
 * Only the number is formatted.
 *
 * **Never renders «0».** A quantity that rounds below what the column can
 * hold (`MIN_QTY`) is not «0 г» — that would claim the recipe asks for none
 * of something. It renders as «—», the same as a quantity that was never
 * stated, which is exactly what a rescale to a tiny portion count means.
 */
export function formatRecipeQty(
  qty: number | null,
  unit: string | null,
): string {
  if (qty === null || !Number.isFinite(qty)) {
    return NO_QUANTITY;
  }

  const rounded = roundQty(qty);
  if (rounded < MIN_QTY) {
    return NO_QUANTITY;
  }

  const whole = Math.floor(rounded);
  const fraction = rounded - whole;
  const glyph = FRACTION_GLYPHS.find(
    ([value]) => Math.abs(fraction - value) < FRACTION_TOLERANCE,
  )?.[1];

  const number =
    glyph === undefined
      ? formatNumber(rounded)
      : `${whole === 0 ? "" : formatNumber(whole)}${glyph}`;

  return unit === null ? number : `${number} ${unit}`;
}
