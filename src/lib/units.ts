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
