import { describe, expect, it } from "vitest";

import {
  isPurchaseUnit,
  RECIPE_ONLY_UNITS,
  RECIPE_UNITS,
  recipeUnitSchema,
  UNITS,
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
