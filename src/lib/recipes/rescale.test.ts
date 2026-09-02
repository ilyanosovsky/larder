import { describe, expect, it } from "vitest";

import { MIN_QTY } from "@/server/cart/merge";

import { formatRecipeQty, rescaleQty } from "./rescale";

describe("rescaleQty", () => {
  it("leaves a missing quantity missing", () => {
    expect(rescaleQty(null, 16, 8)).toBeNull();
  });

  it("doubles the NYC Cookies flour from 8 to 16 portions", () => {
    expect(rescaleQty(285, 16, 8)).toBe(570);
  });

  it("halves it the other way", () => {
    expect(rescaleQty(285, 4, 8)).toBe(142.5);
  });

  it("is an identity at the base portion count, with no float drift", () => {
    // The reason the early return exists: (285 * 3) / 3 is not 285 in
    // binary floating point for every base, and S7 opens on exactly this case.
    for (const base of [1, 3, 7, 8, 9, 12]) {
      expect(rescaleQty(285, base, base)).toBe(285);
    }
  });

  it("rounds to the storage scale the cart shares", () => {
    // 1/3 of 1 → 0.333, not 0.3333333333333333.
    expect(rescaleQty(1, 1, 3)).toBe(0.333);
  });

  it("returns a value below the storage floor rather than clamping it", () => {
    // Clamping would invent a quantity; rendering is where honesty happens.
    expect(rescaleQty(0.002, 1, 4)).toBe(0.001);
    expect(rescaleQty(0.001, 1, 4)).toBe(0);
  });

  it("leaves the quantity alone when the base is unusable", () => {
    expect(rescaleQty(285, 8, 0)).toBe(285);
    expect(rescaleQty(285, 8, Number.NaN)).toBe(285);
    expect(rescaleQty(285, Number.POSITIVE_INFINITY, 8)).toBe(285);
  });
});

describe("formatRecipeQty", () => {
  it("renders the design's own ingredient rows", () => {
    expect(formatRecipeQty(285, "г")).toBe("285 г");
    expect(formatRecipeQty(0.75, "ч.л.")).toBe("¾ ч.л.");
    expect(formatRecipeQty(0.5, "ч.л.")).toBe("½ ч.л.");
    expect(formatRecipeQty(180, "г")).toBe("180 г");
    expect(formatRecipeQty(2, "шт")).toBe("2 шт");
  });

  it("renders a mixed number with its fraction glyph", () => {
    expect(formatRecipeQty(1.5, "ст.л.")).toBe("1½ ст.л.");
    expect(formatRecipeQty(2.25, null)).toBe("2¼");
  });

  it("recognizes thirds at the stored 3-decimal scale", () => {
    expect(formatRecipeQty(0.333, "стакан")).toBe("⅓ стакан");
    expect(formatRecipeQty(0.667, "стакан")).toBe("⅔ стакан");
  });

  it("falls back to a decimal rather than nudging onto the nearest glyph", () => {
    expect(formatRecipeQty(0.4, "л")).toBe("0,4 л");
    expect(formatRecipeQty(0.7, null)).toBe("0,7");
  });

  it("drops the unit when there is none — «½» on its own", () => {
    expect(formatRecipeQty(0.5, null)).toBe("½");
  });

  it("renders a missing quantity as «—»", () => {
    expect(formatRecipeQty(null, "г")).toBe("—");
    expect(formatRecipeQty(null, null)).toBe("—");
  });

  it("never renders «0» — a vanished quantity reads as «—»", () => {
    expect(formatRecipeQty(0, "г")).toBe("—");
    // 0.0004 rounds to 0 at the storage scale; 0.0005 rounds *up* to the
    // floor, which is what the column would hold, so it renders as itself.
    expect(formatRecipeQty(0.0004, "г")).toBe("—");
    expect(formatRecipeQty(MIN_QTY, "г")).toBe("0,001 г");
  });

  it("survives a non-finite quantity instead of printing NaN", () => {
    expect(formatRecipeQty(Number.NaN, "г")).toBe("—");
    expect(formatRecipeQty(Number.POSITIVE_INFINITY, "г")).toBe("—");
  });

  it("does not group thousands", () => {
    expect(formatRecipeQty(1000, "г")).toBe("1000 г");
  });

  it("formats a rescaled value the same way a stored one is formatted", () => {
    expect(formatRecipeQty(rescaleQty(0.75, 8, 8), "ч.л.")).toBe("¾ ч.л.");
    expect(formatRecipeQty(rescaleQty(285, 16, 8), "г")).toBe("570 г");
  });
});
