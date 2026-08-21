import type { AddCartItemOutput } from "@/server/api/routers/cart";

/**
 * The `cart` message key a toast renders, or `null` when the outcome asks a
 * question instead of reporting something that already happened.
 */
export type CartAddToastKey =
  "toastAdded" | "toastMerged" | "toastUnitMismatch" | "toastRestored";

export interface CartAddAction {
  toastKey: CartAddToastKey | null;
  /**
   * The row to light up. Always the line the outcome is about, including the
   * two that changed nothing (`unitMismatch`, `boughtExists`) — those are
   * exactly the cases the refetch highlight cannot cover, because the row's
   * `updatedAt` did not move and `diffListSnapshot` has nothing to notice.
   * For the three that did write, this simply beats the round trip.
   */
  highlightId: string;
  /** «…уже куплен в этой закупке. Вернуть в „нужно“?» — re-add with `restore`. */
  needsRestoreConfirm: boolean;
}

/**
 * Turns one of `cart.add`'s five outcomes into what S3 does about it.
 *
 * Split out of the screen so the mapping is testable in a node environment —
 * this repo's vitest collects `src/**\/*.test.ts` only, so anything that has to
 * be rendered cannot be covered (see `src/lib/sync/highlight-state.ts` for the
 * same split). It also keeps the five cases in one readable table instead of
 * scattered across handlers:
 *
 * | Outcome        | Toast                          | Then                    |
 * | -------------- | ------------------------------ | ----------------------- |
 * | `added`        | «{icon} {name} — в корзине»     | close                   |
 * | `merged`       | «…уже в корзине — обновлено»    | close, row highlighted  |
 * | `unitMismatch` | «…в других единицах»            | close, row highlighted  |
 * | `boughtExists` | none — the confirm asks instead | restore confirmation    |
 * | `restored`     | «…снова в корзине»              | close                   |
 *
 * `boughtExists` deliberately carries no toast: a question and an
 * announcement competing for the same corner of the screen is how a person
 * misses the question.
 */
export function describeCartAddOutcome(
  result: AddCartItemOutput,
): CartAddAction {
  const highlightId = result.item.id;

  switch (result.outcome) {
    case "added":
      return {
        toastKey: "toastAdded",
        highlightId,
        needsRestoreConfirm: false,
      };
    case "merged":
      return {
        toastKey: "toastMerged",
        highlightId,
        needsRestoreConfirm: false,
      };
    case "unitMismatch":
      return {
        toastKey: "toastUnitMismatch",
        highlightId,
        needsRestoreConfirm: false,
      };
    case "boughtExists":
      return { toastKey: null, highlightId, needsRestoreConfirm: true };
    case "restored":
      return {
        toastKey: "toastRestored",
        highlightId,
        needsRestoreConfirm: false,
      };
  }
}
