import { describe, expect, it } from "vitest";

import { cardPortionsMessage } from "./card-portions";

describe("cardPortionsMessage", () => {
  it("declines «порции» when the recipe stated no noun", () => {
    expect(
      cardPortionsMessage({ portions: 4, portionsBase: 4, yieldUnit: null }),
    ).toEqual({ key: "cardPortions", values: { count: 4 } });
  });

  it("carries the recipe's own noun at the recipe's own count", () => {
    // DESIGN_BRIEF S10's «NYC Cookies ×8 шт».
    expect(
      cardPortionsMessage({
        portions: 8,
        portionsBase: 8,
        yieldUnit: "печений",
      }),
    ).toEqual({
      key: "cardPortionsUnit",
      values: { count: 8, unit: "печений" },
    });
  });

  it("drops the noun once the household cooks a different count", () => {
    // An imported noun has no plural forms we know: «7 печений» rescaled to 3
    // is not «3 печений». The same rule `ingredientsForMessage` states, so S7
    // and S10 cannot disagree about one dish.
    expect(
      cardPortionsMessage({
        portions: 3,
        portionsBase: 8,
        yieldUnit: "печений",
      }),
    ).toEqual({ key: "cardPortions", values: { count: 3 } });
  });

  it("treats a blank noun as no noun", () => {
    expect(
      cardPortionsMessage({ portions: 2, portionsBase: 2, yieldUnit: "   " }),
    ).toEqual({ key: "cardPortions", values: { count: 2 } });
  });
});
