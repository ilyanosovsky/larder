import { z } from "zod";

/**
 * Purchase units for a product (VISION §3.1: "шт / кг / г / л / упаковка").
 *
 * This is the phase-wide canon: cart items, reference-catalog defaults and
 * recipe ingredients all store one of these as text and share this list —
 * VISION's own examples plus the design content's пучок/банка/плитка/г are
 * the decided superset (task 1.2). Extend it here, never redeclare it
 * per-feature.
 */
export const UNITS = [
  "шт",
  "кг",
  "г",
  "л",
  "мл",
  "уп",
  "пучок",
  "банка",
  "плитка",
] as const;

export type Unit = (typeof UNITS)[number];

export const unitSchema = z.enum(UNITS);

/**
 * Kitchen measures a recipe states but nobody buys in.
 *
 * They are added here, in the canon's own module — this file's rule is
 * "extend it here, never redeclare it per-feature" — and deliberately **not**
 * added to `UNITS` itself. `RECIPE_UNITS` is a superset of the purchase
 * canon, not a second canon.
 *
 * Widening `UNITS` would put «щепотка» into `QtyStepper`'s cart unit picker
 * and let `decideCartAdd` merge a teaspoon into a kilogram — both units would
 * compare equal, the quantities would sum, and the row would claim a total
 * nobody can buy. A recipe, on the other hand, has to be able to say «¾ ч.л.»
 * verbatim: rewriting it into grams would invent precision the source never
 * gave (VISION §6.4).
 *
 * The bridge between the two is `isPurchaseUnit`: phase 5.2 turns ingredients
 * into cart lines only for the units the cart actually understands.
 */
export const RECIPE_ONLY_UNITS = [
  "ч.л.",
  "ст.л.",
  "стакан",
  "щепотка",
] as const;

/** Every unit a recipe ingredient may state: the purchase canon plus the above. */
export const RECIPE_UNITS = [...UNITS, ...RECIPE_ONLY_UNITS] as const;

export type RecipeUnit = (typeof RECIPE_UNITS)[number];

export const recipeUnitSchema = z.enum(RECIPE_UNITS);

const PURCHASE_UNITS: ReadonlySet<string> = new Set(UNITS);

/**
 * Can this unit become a cart line? Phase 5.2's gate — «180 г масла» can,
 * «¾ ч.л. соли» cannot, and pretending otherwise would put a teaspoon on a
 * shopping list.
 */
export function isPurchaseUnit(unit: RecipeUnit): unit is Unit {
  return PURCHASE_UNITS.has(unit);
}

/**
 * The two families whose units convert into each other exactly.
 *
 * Mass and volume only, and only by the factor 1000 — «г»↔«кг», «мл»↔«л».
 * Nothing else is a family: «шт», «уп», «пучок», «банка» and «плитка» count
 * things nobody can restate in another unit (three cloves are not one head of
 * garlic), and the recipe-only measures are not here at all, because the
 * grams in a teaspoon differ for salt, flour and honey — VISION §3.4 settles
 * that by normalizing kitchen units at **import**, «а не изобретаются на
 * этапе сборки».
 */
export type UnitFamily = "mass" | "volume";

/**
 * How many base units (г, мл) one unit holds, for the units that have a
 * family. The base unit of each family is the one whose factor is 1, which is
 * also the finer of the two — that is what makes the ratio below exact
 * integer arithmetic in both directions.
 */
const UNIT_BASE_FACTORS: ReadonlyMap<
  string,
  { family: UnitFamily; factor: number }
> = new Map([
  ["г", { family: "mass", factor: 1 }],
  ["кг", { family: "mass", factor: 1000 }],
  ["мл", { family: "volume", factor: 1 }],
  ["л", { family: "volume", factor: 1000 }],
]);

/**
 * Which family a purchase unit belongs to, or `null` for the count-like ones.
 *
 * `null` is the answer for most of the canon and that is deliberate: a family
 * is what licenses a conversion, so a unit with no family can only ever be
 * summed with itself.
 */
export function unitFamily(unit: Unit): UnitFamily | null {
  return UNIT_BASE_FACTORS.get(unit)?.family ?? null;
}

/**
 * Can a quantity in `a` be restated in `b` without inventing anything?
 *
 * True for the same unit, and for two units of the same family. «200 г» and
 * «1 шт» are **not** commensurable — VISION §3.4's own example of a sum a
 * program must refuse to guess at — so this stays false there and the build
 * asks a person instead.
 */
export function areCommensurable(a: Unit, b: Unit): boolean {
  if (a === b) {
    return true;
  }

  const family = unitFamily(a);
  return family !== null && family === unitFamily(b);
}

/**
 * `qty` restated in `to`, or `null` when the two units are not commensurable.
 *
 * **Exact and unrounded.** The factor is 1000 in both directions, so a value
 * the `numeric(10, 3)` column can hold converts up without loss and converts
 * down to a value with three more decimals than it started with — «285 г» →
 * «0,285 кг» exactly. Rounding is the caller's business: task 5.2's build
 * folds with `roundQty` after every addition and applies `MIN_QTY` as the
 * floor, and doing either here would put the cart's storage scale into the
 * unit canon, which the canon has no business knowing.
 *
 * An identical unit returns the caller's own number untouched, before any
 * arithmetic — the same guarantee `rescaleQty` gives for an unmoved slider.
 */
export function convertQty(qty: number, from: Unit, to: Unit): number | null {
  if (from === to) {
    return qty;
  }

  const source = UNIT_BASE_FACTORS.get(from);
  const target = UNIT_BASE_FACTORS.get(to);

  if (
    source === undefined ||
    target === undefined ||
    source.family !== target.family
  ) {
    return null;
  }

  return (qty * source.factor) / target.factor;
}
