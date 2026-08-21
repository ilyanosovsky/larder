import { describe, expect, it } from "vitest";

import {
  decideCartAdd,
  MAX_QTY,
  type ActiveCartLine,
  type CartItemStatus,
} from "@/server/cart/merge";

function line(overrides: Partial<ActiveCartLine> = {}): ActiveCartLine {
  return { qty: 2, unit: "шт", status: "needed", ...overrides };
}

/** The two statuses an active line can carry while it is still to be bought. */
const OPEN_STATUSES: CartItemStatus[] = ["needed", "ordered"];

describe("decideCartAdd — a product not in the cart", () => {
  it("adds a new line with what the caller asked for", () => {
    expect(
      decideCartAdd({
        existing: null,
        addition: { qty: 3, unit: "шт" },
        restore: false,
      }),
    ).toEqual({ outcome: "added", qty: 3, unit: "шт" });
  });

  it("still adds when `restore` is set — there is nothing to restore", () => {
    // A confirmation for an offer about a line that no longer exists (the
    // partner finished the trip in the meantime) must not become a no-op.
    expect(
      decideCartAdd({
        existing: null,
        addition: { qty: 1, unit: "кг" },
        restore: true,
      }),
    ).toEqual({ outcome: "added", qty: 1, unit: "кг" });
  });

  it("rounds the quantity to what the column can hold", () => {
    expect(
      decideCartAdd({
        existing: null,
        addition: { qty: 0.4567, unit: "кг" },
        restore: false,
      }),
    ).toEqual({ outcome: "added", qty: 0.457, unit: "кг" });
  });
});

describe("decideCartAdd — merging into an open line", () => {
  it.each(OPEN_STATUSES)("sums quantities of a %s line", (status) => {
    expect(
      decideCartAdd({
        existing: line({ qty: 6, unit: "шт", status }),
        addition: { qty: 2, unit: "шт" },
        restore: false,
      }),
    ).toEqual({ outcome: "merged", qty: 8, previousQty: 6 });
  });

  it("keeps an ordered line ordered", () => {
    // The decision carries no status: raising the quantity of something the
    // partner already ordered for delivery must not tell them to go buy it.
    const decision = decideCartAdd({
      existing: line({ status: "ordered" }),
      addition: { qty: 1, unit: "шт" },
      restore: false,
    });

    expect(decision).not.toHaveProperty("status");
    expect(decision.outcome).toBe("merged");
  });

  it("reports the quantity from before the merge, for «6 шт → 8 шт»", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: 6 }),
        addition: { qty: 2, unit: "шт" },
        restore: false,
      }),
    ).toMatchObject({ previousQty: 6, qty: 8 });
  });

  it("sums fractional quantities exactly", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: 0.5, unit: "кг" }),
        addition: { qty: 0.5, unit: "кг" },
        restore: false,
      }),
    ).toEqual({ outcome: "merged", qty: 1, previousQty: 0.5 });
  });

  it("does not leak binary floating point into the sum", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE 754. Postgres would store
    // 0.300 in `numeric(10, 3)`, so an unrounded decision would return a
    // number the row does not actually hold.
    expect(
      decideCartAdd({
        existing: line({ qty: 0.1, unit: "кг" }),
        addition: { qty: 0.2, unit: "кг" },
        restore: false,
      }),
    ).toEqual({ outcome: "merged", qty: 0.3, previousQty: 0.1 });
  });

  it("caps a merged total at the column's own ceiling", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: MAX_QTY }),
        addition: { qty: MAX_QTY, unit: "шт" },
        restore: false,
      }),
      // `previousQty` is asserted here too, and this is the one case where it
      // pins the value: everywhere else `existing.qty` happens to equal
      // `merged − added`, so deriving it by subtraction would pass. Capping
      // breaks that identity (10 000 + 10 000 caps to 10 000), which is what
      // makes a derived `previousQty` visibly wrong — it would report 0.
    ).toMatchObject({
      outcome: "merged",
      qty: MAX_QTY,
      previousQty: MAX_QTY,
    });
  });

  it("merges an open line even when `restore` is set", () => {
    // `restore` answers one question — «вернуть купленное в нужно» — and must
    // not quietly mean something else for a line that was never bought.
    expect(
      decideCartAdd({
        existing: line({ qty: 6 }),
        addition: { qty: 2, unit: "шт" },
        restore: true,
      }),
    ).toEqual({ outcome: "merged", qty: 8, previousQty: 6 });
  });
});

describe("decideCartAdd — a different unit", () => {
  it.each(OPEN_STATUSES)("never auto-merges into a %s line", (status) => {
    // VISION §3.4: «200 г» + «1 шт» has no answer a program can pick.
    expect(
      decideCartAdd({
        existing: line({ qty: 1, unit: "шт", status }),
        addition: { qty: 200, unit: "г" },
        restore: false,
      }),
    ).toEqual({ outcome: "unitMismatch" });
  });

  it("leaves the row untouched — the decision carries no quantity", () => {
    expect(
      decideCartAdd({
        existing: line({ unit: "шт" }),
        addition: { qty: 200, unit: "г" },
        restore: false,
      }),
    ).not.toHaveProperty("qty");
  });

  it("treats a unit the app no longer recognizes as a mismatch, not as «шт»", () => {
    // The stored value is compared as stored. If the router normalized it
    // first, «мешок» would arrive here as «шт» and sum into a «шт» addition —
    // changing the quantity while the row's own unit stayed «мешок».
    expect(
      decideCartAdd({
        existing: line({ qty: 2, unit: "мешок" }),
        addition: { qty: 6, unit: "шт" },
        restore: false,
      }),
    ).toEqual({ outcome: "unitMismatch" });
  });

  it("refuses the mismatch with `restore` too", () => {
    expect(
      decideCartAdd({
        existing: line({ unit: "шт" }),
        addition: { qty: 200, unit: "г" },
        restore: true,
      }),
    ).toEqual({ outcome: "unitMismatch" });
  });
});

describe("decideCartAdd — a line already bought in this trip", () => {
  it("offers to bring it back instead of resurrecting it silently", () => {
    expect(
      decideCartAdd({
        existing: line({ status: "bought" }),
        addition: { qty: 2, unit: "шт" },
        restore: false,
      }),
    ).toEqual({ outcome: "boughtExists" });
  });

  it("asks about the purchase before it asks about units", () => {
    // A bought line with a different unit is still «уже купили?», not a unit
    // question: restoring replaces the unit anyway, so asking about units
    // first would make the shopper resolve a conflict that is about to vanish.
    expect(
      decideCartAdd({
        existing: line({ unit: "шт", status: "bought" }),
        addition: { qty: 200, unit: "г" },
        restore: false,
      }),
    ).toEqual({ outcome: "boughtExists" });
  });

  it("restores it on the confirming call", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: 6, status: "bought" }),
        addition: { qty: 2, unit: "шт" },
        restore: true,
      }),
    ).toEqual({ outcome: "restored", qty: 2, unit: "шт" });
  });

  it("takes the new quantity rather than summing — the old one was paid for", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: 6, status: "bought" }),
        addition: { qty: 2, unit: "шт" },
        restore: true,
      }),
    ).toMatchObject({ qty: 2 });
  });

  it("takes the new unit as well", () => {
    expect(
      decideCartAdd({
        existing: line({ qty: 1, unit: "шт", status: "bought" }),
        addition: { qty: 0.5, unit: "кг" },
        restore: true,
      }),
    ).toEqual({ outcome: "restored", qty: 0.5, unit: "кг" });
  });
});
