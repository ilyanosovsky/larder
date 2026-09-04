import { describe, expect, it } from "vitest";

import {
  areCommensurable,
  convertQty,
  isPurchaseUnit,
  RECIPE_ONLY_UNITS,
  RECIPE_UNITS,
  recipeUnitSchema,
  UNITS,
  unitFamily,
  unitSchema,
} from "./units";

describe("UNITS", () => {
  it("is exactly the nine purchase units — the cart canon must not widen", () => {
    // A regression test with a purpose: `RECIPE_UNITS` below is a superset,
    // and the whole point of keeping it separate is that adding «щепотка» to
    // a recipe never lets `decideCartAdd` merge a pinch into a kilogram.
    expect([...UNITS]).toEqual([
      "шт",
      "кг",
      "г",
      "л",
      "мл",
      "уп",
      "пучок",
      "банка",
      "плитка",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(UNITS).size).toBe(UNITS.length);
  });
});

describe("RECIPE_UNITS", () => {
  it("is the purchase canon followed by the recipe-only measures", () => {
    expect([...RECIPE_UNITS]).toEqual([...UNITS, ...RECIPE_ONLY_UNITS]);
  });

  it("has no duplicates", () => {
    expect(new Set(RECIPE_UNITS).size).toBe(RECIPE_UNITS.length);
  });

  it("accepts every purchase unit", () => {
    for (const unit of UNITS) {
      expect(recipeUnitSchema.safeParse(unit).success).toBe(true);
    }
  });

  it("accepts «ч.л.», which the cart's own schema rejects", () => {
    expect(recipeUnitSchema.safeParse("ч.л.").success).toBe(true);
    expect(unitSchema.safeParse("ч.л.").success).toBe(false);
  });

  it("rejects an unknown measure", () => {
    expect(recipeUnitSchema.safeParse("мешок").success).toBe(false);
  });
});

describe("isPurchaseUnit", () => {
  it("is true for every purchase unit", () => {
    for (const unit of UNITS) {
      expect(isPurchaseUnit(unit)).toBe(true);
    }
  });

  it("is false for every recipe-only measure", () => {
    for (const unit of RECIPE_ONLY_UNITS) {
      expect(isPurchaseUnit(unit)).toBe(false);
    }
  });
});

describe("unitFamily", () => {
  it("puts «г» and «кг» in one family and «мл» and «л» in another", () => {
    expect(unitFamily("г")).toBe("mass");
    expect(unitFamily("кг")).toBe("mass");
    expect(unitFamily("мл")).toBe("volume");
    expect(unitFamily("л")).toBe("volume");
  });

  it("gives every count-like unit no family at all", () => {
    // The list is spelled out rather than derived: this is the assertion that
    // fails if somebody ever files «уп» under mass because a pack has a
    // weight. A pack does not convert to grams — that is the whole point.
    for (const unit of ["шт", "уп", "пучок", "банка", "плитка"] as const) {
      expect(unitFamily(unit)).toBeNull();
    }
  });
});

describe("areCommensurable", () => {
  it("is true for a unit and itself, family or not", () => {
    for (const unit of UNITS) {
      expect(areCommensurable(unit, unit)).toBe(true);
    }
  });

  it("is true within a family, in both directions", () => {
    expect(areCommensurable("г", "кг")).toBe(true);
    expect(areCommensurable("кг", "г")).toBe(true);
    expect(areCommensurable("мл", "л")).toBe(true);
    expect(areCommensurable("л", "мл")).toBe(true);
  });

  it("is false across families — a millilitre is not a gram", () => {
    expect(areCommensurable("г", "мл")).toBe(false);
    expect(areCommensurable("кг", "л")).toBe(false);
  });

  it("is false for «200 г» against «1 шт» — VISION §3.4's own example", () => {
    expect(areCommensurable("г", "шт")).toBe(false);
    expect(areCommensurable("шт", "уп")).toBe(false);
  });
});

describe("convertQty", () => {
  it("returns the caller's own number for an identical unit", () => {
    // Untouched, not rounded: a value that never came from the column (0.1 +
    // 0.2) comes back bit-identical, the same guarantee `rescaleQty` gives.
    expect(convertQty(0.1 + 0.2, "г", "г")).toBe(0.1 + 0.2);
  });

  it("converts «285 г» to «0,285 кг» exactly", () => {
    expect(convertQty(285, "г", "кг")).toBe(0.285);
  });

  it("converts «1 кг» to «1000 г» and «1 л» to «1000 мл»", () => {
    expect(convertQty(1, "кг", "г")).toBe(1000);
    expect(convertQty(1, "л", "мл")).toBe(1000);
    expect(convertQty(200, "мл", "л")).toBe(0.2);
  });

  it("does not round — the caller owns the storage scale", () => {
    // 0,4 г is 0,0004 кг, which `numeric(10, 3)` cannot hold. Rounding here
    // would hand the build a confident «0», which is exactly what MIN_QTY
    // exists to stop; the build sees the real number and calls it too small.
    expect(convertQty(0.4, "г", "кг")).toBe(0.0004);
  });

  it("is null across families and for count-like units", () => {
    expect(convertQty(1, "г", "мл")).toBeNull();
    expect(convertQty(1, "шт", "уп")).toBeNull();
    expect(convertQty(1, "кг", "шт")).toBeNull();
  });

  it("round-trips every commensurable pair", () => {
    for (const from of UNITS) {
      for (const to of UNITS) {
        const there = convertQty(7, from, to);

        if (!areCommensurable(from, to)) {
          expect(there).toBeNull();
          continue;
        }

        expect(there).not.toBeNull();
        expect(convertQty(there as number, to, from)).toBeCloseTo(7, 10);
      }
    }
  });
});
