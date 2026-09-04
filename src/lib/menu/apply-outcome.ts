import type { CartPlan } from "@/server/menu/build-cart";

/**
 * What S10 and S7 do with `menu.applyCart`'s answer, and what the sheet says
 * when there was nothing to answer about.
 *
 * The same split `describeCartAddOutcome` makes for S3, for the same reason:
 * vitest runs in **node** and collects `src/**\/*.test.ts` only, so a branch
 * left inside a `.tsx` is unreachable from the suite and a flipped one ships
 * green. Every decision here returns a `{ key, values }` pair the screen hands
 * straight to `t(...)`, so the Russian lives in `ru.json` (AGENTS.md) and
 * `ru.test.ts` can render these exact branches rather than a local copy of
 * them.
 *
 * The `@/server/menu/build-cart` import is **type-only** and fully erased.
 */

/** One `menuBuild` message, chosen by logic and worded by the dictionary. */
export type ApplyMessage =
  | { readonly key: "toastAdded"; readonly values: { readonly count: number } }
  | { readonly key: "alreadyApplied"; readonly values: Record<string, never> }
  | {
      readonly key: "resultApplied";
      readonly values: { readonly count: number };
    }
  | {
      readonly key: "resultSkipped";
      readonly values: { readonly count: number };
    }
  | {
      readonly key: "resultUnitMismatch";
      readonly values: { readonly name: string };
    }
  | {
      readonly key: "resultBought";
      readonly values: { readonly name: string };
    };

/** The five outcomes `decideCartAdd` answers with, per applied line. */
export type ApplyLineOutcome =
  "added" | "merged" | "restored" | "unitMismatch" | "boughtExists";

/**
 * What `describeApplyOutcome` reads. Structural rather than imported from the
 * router, so this module stays free of the server's dependency graph;
 * `applyCartOutput`'s inferred type satisfies it by construction.
 */
export interface ApplyOutcomeResult {
  outcome: "applied" | "alreadyApplied";
  applied: number;
  skipped: number;
  lines: ReadonlyArray<{ productName: string; outcome: ApplyLineOutcome }>;
}

/**
 * «Готово не всё» — the panel that replaces the sheet's body (D23).
 *
 * A panel rather than a toast because a toast saying «2 не добавили» loses
 * *which* products and *why*, and those are the two things a person needs to
 * fix it. The sheet stays open and keeps focus, which is also the only way the
 * message survives: a full-screen `aria-modal` prunes live regions outside
 * itself, so feedback rendered anywhere else would never be announced.
 */
export interface ApplyResultPanel {
  /** «Добавили N» — `null` when nothing was written. */
  readonly applied: ApplyMessage | null;
  /** «N позиций не добавили» — `null` when the cart refused nothing. */
  readonly skipped: ApplyMessage | null;
  /** One line per refusal, in the order the apply reported them. */
  readonly reasons: readonly ApplyMessage[];
}

/**
 * | outcome        | applied | skipped | Result                                   |
 * | -------------- | ------- | ------- | ---------------------------------------- |
 * | alreadyApplied | 0       | 0       | in-sheet panel: «Эту корзину уже собрали» |
 * | applied        | > 0     | 0       | close the sheet, toast + «Открыть»       |
 * | applied        | > 0     | > 0     | keep the sheet open, result panel (D23)  |
 * | applied        | 0       | > 0     | keep the sheet open, result panel        |
 * | applied        | 0       | 0       | unreachable: the input requires `.min(1)` |
 *
 * The last row is not defended against with a throw: it can only be reached by
 * a server that answered `applied` for an empty selection, and a panel saying
 * «добавили 0» is a better failure than a crash on the one screen the person
 * is looking at.
 */
export type ApplyResultView =
  | { readonly kind: "toast"; readonly toast: ApplyMessage }
  | { readonly kind: "alreadyApplied"; readonly message: ApplyMessage }
  | { readonly kind: "panel"; readonly panel: ApplyResultPanel };

export function describeApplyOutcome(
  result: ApplyOutcomeResult,
): ApplyResultView {
  if (result.outcome === "alreadyApplied") {
    // The request landed once already and its answer was lost on the way back
    // (D7). Reporting «добавили 0» would read as a failure; this reads as what
    // it is — the work is done.
    return {
      kind: "alreadyApplied",
      message: { key: "alreadyApplied", values: {} },
    };
  }

  if (result.skipped === 0 && result.applied > 0) {
    return {
      kind: "toast",
      toast: { key: "toastAdded", values: { count: result.applied } },
    };
  }

  return {
    kind: "panel",
    panel: {
      applied:
        result.applied > 0
          ? { key: "resultApplied", values: { count: result.applied } }
          : null,
      skipped:
        result.skipped > 0
          ? { key: "resultSkipped", values: { count: result.skipped } }
          : null,
      reasons: result.lines.flatMap((line): ApplyMessage[] => {
        if (line.outcome === "unitMismatch") {
          return [
            {
              key: "resultUnitMismatch",
              values: { name: line.productName },
            },
          ];
        }
        if (line.outcome === "boughtExists") {
          return [{ key: "resultBought", values: { name: line.productName } }];
        }
        return [];
      }),
    },
  };
}

/** The one sentence an empty preview gets, chosen by what emptied it. */
export type PreviewEmptyMessage = {
  readonly key: "allCooked" | "nothingBound" | "nothingToAdd";
  readonly values: Record<string, never>;
};

/**
 * Why there is nothing to add — three answers, because they are three
 * different situations and only one of them is «всё уже дома».
 *
 * `allCooked` first: a pool whose every dish is ticked «приготовлено» has
 * *not* been shopped for out of the pantry, and the fix is to untick a card
 * (D17). `nothingBound` next: every ingredient the dishes name is unbound, so
 * the fix is to open the dish and pick products — a sentence «всё уже дома»
 * would send the person looking in the wrong place. `nothingToAdd` last, as
 * the honest default.
 *
 * Called only when `lines` is empty; the last branch is what an ordinary
 * "everything is covered" preview renders.
 */
export function describePreviewEmpty(
  plan: Pick<CartPlan, "lines" | "skipped" | "dishCount" | "cookedSkipped">,
): PreviewEmptyMessage {
  if (plan.dishCount === 0 && plan.cookedSkipped > 0) {
    return { key: "allCooked", values: {} };
  }

  if (plan.lines.length === 0 && plan.skipped.length > 0) {
    return { key: "nothingBound", values: {} };
  }

  return { key: "nothingToAdd", values: {} };
}
