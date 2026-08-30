import type { RanOutOutput } from "@/server/api/routers/pantry";

/** The `pantry` message key a toast renders, or `null` for a silent outcome. */
export type PantryRanOutToastKey = "toastInCart" | "toastAlreadyInCart";

export interface PantryRanOutAction {
  toastKey: PantryRanOutToastKey | null;
}

/**
 * Turns one of `pantry.ranOut`'s four outcomes into what S5 tells the shopper
 * — split out for the same reason `describeCartAddOutcome`
 * (`src/lib/cart/add-outcome.ts`) is: this repo's vitest collects
 * `src/**\/*.test.ts` only, so anything that has to be rendered cannot be
 * covered there.
 *
 * | Outcome         | Toast              |
 * | --------------- | ------------------- |
 * | `added`         | «В корзине»          |
 * | `restored`      | «В корзине»          |
 * | `alreadyInCart` | «Уже в корзине»      |
 * | `gone`          | none — silent        |
 *
 * `added` and `restored` share a toast on purpose: from the shopper's side
 * both simply mean "it's back on the list now", and the distinction (a fresh
 * line vs. one that had been bought in the still-open trip and needed to go
 * back) is server bookkeeping, not something worth a different sentence.
 *
 * `gone` is silent rather than repeating either toast: the tap belonged to a
 * pantry row a partner's own tap (or a replayed queue entry) already cleared,
 * and the row is already gone from this screen by the time the answer comes
 * back — there is nothing on screen left to point a toast at.
 */
export function describePantryRanOutOutcome(
  result: RanOutOutput,
): PantryRanOutAction {
  switch (result.outcome) {
    case "added":
    case "restored":
      return { toastKey: "toastInCart" };
    case "alreadyInCart":
      return { toastKey: "toastAlreadyInCart" };
    case "gone":
      return { toastKey: null };
  }
}
