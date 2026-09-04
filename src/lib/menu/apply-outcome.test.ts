import { describe, expect, it } from "vitest";

import {
  describeApplyOutcome,
  describePreviewEmpty,
  type ApplyOutcomeResult,
} from "@/lib/menu/apply-outcome";
import type { CartPlan, PreviewLine } from "@/server/menu/build-cart";

function result(
  overrides: Partial<ApplyOutcomeResult> = {},
): ApplyOutcomeResult {
  return {
    outcome: "applied",
    applied: 0,
    skipped: 0,
    lines: [],
    ...overrides,
  };
}

function emptyPlan(
  overrides: Partial<
    Pick<CartPlan, "lines" | "skipped" | "dishCount" | "cookedSkipped">
  > = {},
) {
  return {
    lines: [] as PreviewLine[],
    skipped: [],
    dishCount: 1,
    cookedSkipped: 0,
    ...overrides,
  };
}

describe("describeApplyOutcome", () => {
  it("a replay reports itself instead of «добавили 0»", () => {
    expect(describeApplyOutcome(result({ outcome: "alreadyApplied" }))).toEqual(
      {
        kind: "alreadyApplied",
        message: { key: "alreadyApplied", values: {} },
      },
    );
  });

  it("a clean apply closes the sheet and fires the toast", () => {
    expect(describeApplyOutcome(result({ applied: 8 }))).toEqual({
      kind: "toast",
      toast: { key: "toastAdded", values: { count: 8 } },
    });
  });

  it("a partial apply keeps the sheet open and names every refusal", () => {
    const view = describeApplyOutcome(
      result({
        applied: 6,
        skipped: 2,
        lines: [
          { productName: "Лук", outcome: "added" },
          { productName: "Мука", outcome: "unitMismatch" },
          { productName: "Яйца", outcome: "boughtExists" },
        ],
      }),
    );

    expect(view).toEqual({
      kind: "panel",
      panel: {
        applied: { key: "resultApplied", values: { count: 6 } },
        skipped: { key: "resultSkipped", values: { count: 2 } },
        reasons: [
          { key: "resultUnitMismatch", values: { name: "Мука" } },
          { key: "resultBought", values: { name: "Яйца" } },
        ],
      },
    });
  });

  it("an apply the cart refused entirely still explains itself", () => {
    const view = describeApplyOutcome(
      result({
        applied: 0,
        skipped: 1,
        lines: [{ productName: "Мука", outcome: "unitMismatch" }],
      }),
    );

    expect(view).toMatchObject({
      kind: "panel",
      panel: { applied: null },
    });
  });

  it("degrades to a panel rather than crashing on an impossible answer", () => {
    // `applyCartInput` requires `.min(1)` selection, so applied 0 / skipped 0
    // cannot happen — and a panel saying nothing is a better failure than a
    // crash on the screen the person is looking at.
    expect(describeApplyOutcome(result()).kind).toBe("panel");
  });
});

describe("describePreviewEmpty", () => {
  it("says «все блюда уже приготовлены» when that is what emptied the pool", () => {
    expect(
      describePreviewEmpty(emptyPlan({ dishCount: 0, cookedSkipped: 2 })),
    ).toEqual({ key: "allCooked", values: {} });
  });

  it("points at the dish when every ingredient is unbound", () => {
    expect(
      describePreviewEmpty(
        emptyPlan({
          skipped: [
            {
              ingredientId: "3f1a6d0e-0000-4000-8000-000000000301",
              dishId: "3f1a6d0e-0000-4000-8000-000000000302",
              dishTitle: "Лазанья",
              name: "Специи по-домашнему",
              qty: null,
              unit: null,
              reason: "unbound",
            },
          ],
        }),
      ),
    ).toEqual({ key: "nothingBound", values: {} });
  });

  it("falls back to «всё уже дома или в корзине»", () => {
    expect(describePreviewEmpty(emptyPlan())).toEqual({
      key: "nothingToAdd",
      values: {},
    });
  });

  it("prefers «приготовлено» over «не привязано» — the fix is a different one", () => {
    expect(
      describePreviewEmpty(
        emptyPlan({
          dishCount: 0,
          cookedSkipped: 1,
          skipped: [
            {
              ingredientId: "3f1a6d0e-0000-4000-8000-000000000301",
              dishId: "3f1a6d0e-0000-4000-8000-000000000302",
              dishTitle: "Лазанья",
              name: "Специи",
              qty: null,
              unit: null,
              reason: "unbound",
            },
          ],
        }),
      ).key,
    ).toBe("allCooked");
  });
});
