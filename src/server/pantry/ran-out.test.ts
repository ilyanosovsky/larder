import { describe, expect, it } from "vitest";

import {
  decidePantryRanOut,
  RAN_OUT_QTY,
  type RanOutActiveLine,
} from "@/server/pantry/ran-out";
import type { CartItemStatus } from "@/server/cart/merge";

function line(status: CartItemStatus): RanOutActiveLine {
  return { status };
}

describe("decidePantryRanOut — no active line", () => {
  it("adds a new needed line at qty 1, in the product's default unit", () => {
    expect(
      decidePantryRanOut({ existing: null, defaultUnit: "кг" }),
    ).toEqual({ outcome: "added", qty: RAN_OUT_QTY, unit: "кг" });
  });

  it("uses whatever default unit the product carries, not a fixed one", () => {
    // Companion to the test above: a different unit, expecting *that* one
    // back — proves the decision reads `defaultUnit` rather than a hardcoded
    // «кг», which would pass the first test by coincidence.
    expect(
      decidePantryRanOut({ existing: null, defaultUnit: "шт" }),
    ).toEqual({ outcome: "added", qty: RAN_OUT_QTY, unit: "шт" });
  });

  it("RAN_OUT_QTY is the smallest whole quantity — there is no previous qty to reuse", () => {
    // Unlike `cart.add`'s restore branch, an `added` line here has no prior
    // purchase to take a quantity from — the pantry itself records no
    // quantities (VISION §3.2) — so it always starts at exactly one.
    expect(RAN_OUT_QTY).toBe(1);
  });
});

describe("decidePantryRanOut — an open line already there", () => {
  it.each<CartItemStatus>(["needed", "ordered"])(
    "leaves a %s line completely untouched",
    (status) => {
      expect(
        decidePantryRanOut({ existing: line(status), defaultUnit: "шт" }),
      ).toEqual({ outcome: "alreadyInCart" });
    },
  );
});

describe("decidePantryRanOut — a line bought in the still-open trip", () => {
  it("restores it to needed rather than adding a second line", () => {
    expect(
      decidePantryRanOut({ existing: line("bought"), defaultUnit: "шт" }),
    ).toEqual({ outcome: "restored" });
  });

  it("carries no qty/unit for a restore — the row keeps its own", () => {
    const decision = decidePantryRanOut({
      existing: line("bought"),
      defaultUnit: "кг",
    });

    expect(decision).not.toHaveProperty("qty");
    expect(decision).not.toHaveProperty("unit");
  });
});
