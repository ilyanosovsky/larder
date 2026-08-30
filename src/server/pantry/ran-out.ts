import type { CartItemStatus } from "@/server/cart/merge";
import type { Unit } from "@/lib/units";

/**
 * What "Кончилось" should do to the cart (VISION §3.2) — the decision half of
 * `pantry.ranOut`, with no database in it. Kept pure and unit-tested on its
 * own the same way `src/server/cart/merge.ts` is; the router owns the locking
 * read, the pantry row's deletion and the write, this module only owns *what*
 * the write should be.
 *
 * Deliberately narrower than `decideCartAdd` (`src/server/cart/merge.ts`):
 * «кончилось» asserts *presence*, not a quantity to add on top of one that
 * may already be there, so there is no merge branch and no unit-mismatch
 * question to ask — a fresh line always starts at `RAN_OUT_QTY`, in the
 * product's own default unit, regardless of what was ever bought before.
 */

/** The quantity a fresh line gets. Always 1 — see the module doc comment. */
export const RAN_OUT_QTY = 1;

/** The product's existing active row (`trip_id IS NULL`), as the rules see it.
 * Narrower than `ActiveCartLine` in `merge.ts`: this decision never looks at
 * quantity or unit, only at which of the three statuses the line is in. */
export interface RanOutActiveLine {
  status: CartItemStatus;
}

export interface RanOutContext {
  /** The product's active row, or `null` when it has none. */
  existing: RanOutActiveLine | null;
  /** The product's `defaultUnit` — what a freshly inserted line is priced in. */
  defaultUnit: Unit;
}

/**
 * What `pantry.ranOut` should do, and what the caller is told about it.
 *
 * `alreadyInCart` and `restored` carry no qty/unit: the first leaves the row
 * exactly as it is, and the second reuses whatever qty/unit the row already
 * holds rather than reporting a new one — the router applies `qty`/`unit`
 * only for `added`.
 */
export type RanOutDecision =
  | { outcome: "added"; qty: number; unit: Unit }
  | { outcome: "alreadyInCart" }
  | { outcome: "restored" };

/**
 * The rules for what happens to the cart when a pantry item runs out
 * (VISION §3.2, DESIGN_BRIEF S5):
 *
 * | Existing active row       | Decision                                      |
 * | -------------------------- | --------------------------------------------- |
 * | none                       | `added` — a new `needed` line, qty 1          |
 * | `needed` / `ordered`       | `alreadyInCart` — row left completely alone   |
 * | `bought`                   | `restored` — back to `needed`, qty/unit as-is |
 *
 * **`needed`/`ordered` are untouched, not bumped.** «Кончилось» asserts
 * presence-needed, not quantity math — the shopper already has one line for
 * this product, on its way in or already on the list, and a second tap on
 * the pantry cannot mean "buy more of it" without also knowing how many are
 * actually gone, which the pantry (VISION §3.2: "наличие без количеств") does
 * not track.
 *
 * **A `bought` line restores rather than resurrecting a second row.** It was
 * bought in the still-open trip and then ran out again before the trip
 * closed — an edge case, but a real one (a big pack finished mid-shop) — and
 * the fix is the same one `cart.add`'s `restore` offers: back to `needed`,
 * keeping the row's own qty and unit rather than resetting them, because
 * there is no new quantity here to reset them *to*. Unlike `cart.add`, this
 * never asks first — the pantry action already **is** the confirmation; there
 * is no second tap to gate it behind.
 */
export function decidePantryRanOut({
  existing,
  defaultUnit,
}: RanOutContext): RanOutDecision {
  if (!existing) {
    return { outcome: "added", qty: RAN_OUT_QTY, unit: defaultUnit };
  }

  if (existing.status === "bought") {
    return { outcome: "restored" };
  }

  return { outcome: "alreadyInCart" };
}
