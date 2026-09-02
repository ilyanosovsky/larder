import type { cartItemStatusEnum } from "@/db/schema";
import type { Unit } from "@/lib/units";

/**
 * What happens when a product that may already be in the cart is added again
 * (VISION §3.1) — the decision half of `cart.add`, with no database in it.
 *
 * Kept pure so every branch is unit-testable on its own, the way
 * `src/server/catalog/` holds the ranking and permutation rules. The router
 * owns the locking read, the write and the unique-index recovery; this module
 * owns *what* the write should be.
 */

/**
 * The three statuses, taken from the database enum itself rather than
 * re-declared here. The import is type-only and therefore fully erased, so
 * this module stays free of drizzle at runtime while still being unable to
 * drift from the column it decides on: a fourth status added to
 * `cartItemStatusEnum` would stop compiling here until it is handled.
 */
export type CartItemStatus = (typeof cartItemStatusEnum)["enumValues"][number];

/**
 * The scale of `cart_items.qty` (`numeric(10, 3)`). Sums are rounded to it so
 * the number this module returns is the number the column will actually hold —
 * without that, «0.1 + 0.2» would decide 0.30000000000000004, Postgres would
 * store 0.300, and the response would disagree with the row it just wrote.
 */
const QTY_DECIMALS = 3;

/** The smallest quantity the column can hold without rounding down to zero. */
export const MIN_QTY = 10 ** -QTY_DECIMALS;

/**
 * The ceiling for a single addition *and* for a merged total. Nobody buys ten
 * thousand of anything; a bigger number in the box is a typo, and capping the
 * sum as well keeps a long run of merges from ever pushing `numeric(10, 3)`
 * past its own range and turning an ordinary tap into a 500.
 */
export const MAX_QTY = 10_000;

/** A product's existing active row (`trip_id IS NULL`), as the rules see it. */
export interface ActiveCartLine {
  qty: number;
  /**
   * The unit **exactly as the row stores it** — a raw `string`, not a `Unit`.
   *
   * The column is text, so it can hold a value the app no longer recognizes
   * (a unit dropped from `UNITS`, a row edited out of band). Rendering degrades
   * such a value to «шт» so one bad row cannot fail the whole cart's output
   * validation — but the *merge decision* must never see that substitution.
   * Comparing the degraded value would make a row holding «мешок» look like a
   * «шт» row and silently sum into it: the quantity would change while the
   * stored unit did not, and the response would report a unit the row does not
   * have. Compared raw, an unrecognized unit simply never matches, so it falls
   * to `unitMismatch` and a person decides — which is the whole point of the
   * rule.
   */
  unit: string;
  status: CartItemStatus;
}

/** What the caller is adding right now. */
export interface CartAddition {
  qty: number;
  unit: Unit;
}

export interface CartAddContext {
  /** The product's active row, or `null` when it has none. */
  existing: ActiveCartLine | null;
  addition: CartAddition;
  /**
   * The second call, after the UI offered «вернуть в нужно» for a line that
   * was already bought in the still-open trip. It is a confirmation of that
   * one offer and nothing else — see `decideCartAdd`.
   */
  restore: boolean;
}

/**
 * What `cart.add` should do, and what the caller gets told about it.
 *
 * `qty`/`unit` are the values to write; the two outcomes that carry neither
 * (`unitMismatch`, `boughtExists`) are the ones where the row is left exactly
 * as it is and the screen asks a question instead.
 */
export type CartAddDecision =
  | { outcome: "added"; qty: number; unit: Unit }
  | { outcome: "merged"; qty: number; previousQty: number }
  | { outcome: "unitMismatch" }
  | { outcome: "boughtExists" }
  | { outcome: "restored"; qty: number; unit: Unit };

/**
 * Rounds to the scale `cart_items.qty` and `recipe_ingredients.qty` share.
 *
 * Exported because the recipe rescale (`src/lib/recipes/rescale.ts`) has to
 * round the same way: the two columns are byte-identical `numeric(10, 3)` on
 * purpose, so that phase 5.2 can sum a rescaled ingredient quantity straight
 * into a cart row without a second rounding rule that could disagree with the
 * row it writes.
 */
export function roundQty(value: number): number {
  const factor = 10 ** QTY_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * The merge rules for adding a product to the cart (VISION §3.1, §3.4).
 *
 * | Existing active row      | Decision                                   |
 * | ------------------------ | ------------------------------------------ |
 * | none                     | `added` — a new `needed` line              |
 * | `needed`/`ordered`, same unit | `merged` — quantities summed          |
 * | `needed`/`ordered`, other unit | `unitMismatch` — row untouched       |
 * | `bought`                 | `boughtExists`, or `restored` with `restore` |
 *
 * Three things here are decisions, not implementation details:
 *
 * **Different units are never summed.** «200 г» plus «1 шт» has no answer a
 * program can pick, so the row is left alone and the screen asks — the same
 * principle VISION §3.4 states for building the cart from the week's menu.
 * Guessing here would quietly corrupt a shopping list, and the shopper would
 * only find out at the shelf. The comparison is against the unit the row
 * actually stores (see `ActiveCartLine.unit`), so a value the app no longer
 * recognizes falls here too rather than being normalized into a false match.
 *
 * **`ordered` merges without falling back to `needed`.** The partner has
 * already put that line in a delivery order; raising the quantity does not
 * un-order it, and flipping the status back would tell them to buy something
 * that is already on its way.
 *
 * **A `bought` line takes two calls.** It was bought in the still-open trip,
 * so a plain add would otherwise silently resurrect a finished purchase.
 * `restore` confirms the offer the screen made; the restored line takes the
 * *new* quantity rather than a sum, because the old one has been paid for
 * already. `restore` is scoped to exactly that case: sent for a line that is
 * not bought, it is ignored and the ordinary rules apply, so a stale
 * confirmation from a screen whose partner moved the line on in the meantime
 * cannot mean something the shopper never asked for.
 */
export function decideCartAdd({
  existing,
  addition,
  restore,
}: CartAddContext): CartAddDecision {
  const qty = roundQty(addition.qty);

  if (!existing) {
    return { outcome: "added", qty, unit: addition.unit };
  }

  // Checked before the unit, deliberately: a bought line is a question about
  // the purchase, not about units, and restoring it replaces the unit anyway.
  if (existing.status === "bought") {
    return restore
      ? { outcome: "restored", qty, unit: addition.unit }
      : { outcome: "boughtExists" };
  }

  if (existing.unit !== addition.unit) {
    return { outcome: "unitMismatch" };
  }

  return {
    outcome: "merged",
    previousQty: existing.qty,
    qty: Math.min(roundQty(existing.qty + qty), MAX_QTY),
  };
}
