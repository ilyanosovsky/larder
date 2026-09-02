import { describe, expect, it } from "vitest";

import {
  formatQtyInput,
  minutesFromSeconds,
  parseMinutesInput,
  parseQtyInput,
  secondsFromMinutes,
} from "@/lib/recipes/form-fields";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";

describe("parseQtyInput", () => {
  it("reads a plain number", () => {
    expect(parseQtyInput("285")).toBe(285);
    expect(parseQtyInput(" 2 ")).toBe(2);
  });

  it("reads a comma as the decimal point a Russian keyboard produces", () => {
    expect(parseQtyInput("0,5")).toBe(0.5);
  });

  it("reads back the fractions the card renders", () => {
    expect(parseQtyInput("¾")).toBe(0.75);
    expect(parseQtyInput("½")).toBe(0.5);
  });

  it("is null for an empty field — «unstated» is a real answer", () => {
    expect(parseQtyInput("")).toBeNull();
    expect(parseQtyInput("   ")).toBeNull();
  });

  it("is null for words, never a number", () => {
    expect(parseQtyInput("по вкусу")).toBeNull();
    expect(parseQtyInput("2 шт")).toBeNull();
  });

  it("refuses out-of-range values instead of clamping them", () => {
    // A silently corrected quantity is worse than a missing one: the amber
    // chip is honest, «10000 г» quietly turned into the ceiling is not.
    expect(parseQtyInput(String(MAX_QTY + 1))).toBeNull();
    expect(parseQtyInput("0")).toBeNull();
    expect(parseQtyInput(String(MIN_QTY))).toBe(MIN_QTY);
    expect(parseQtyInput(String(MAX_QTY))).toBe(MAX_QTY);
  });

  it("is null for Infinity and NaN spellings", () => {
    expect(parseQtyInput("Infinity")).toBeNull();
    expect(parseQtyInput("NaN")).toBeNull();
  });
});

describe("formatQtyInput", () => {
  it("shows a stored quantity as an editable decimal", () => {
    expect(formatQtyInput(285)).toBe("285");
    expect(formatQtyInput(0.5)).toBe("0.5");
    expect(formatQtyInput(1 / 3)).toBe("0.333");
  });

  it("is empty for an unstated quantity", () => {
    expect(formatQtyInput(null)).toBe("");
  });

  it("round-trips through parseQtyInput", () => {
    for (const value of [1, 2.5, 285, 0.25, MIN_QTY]) {
      expect(parseQtyInput(formatQtyInput(value))).toBe(value);
    }
  });
});

describe("parseMinutesInput", () => {
  it("reads whole minutes", () => {
    expect(parseMinutesInput("30", 6000)).toBe(30);
    expect(parseMinutesInput(" 9 ", 600)).toBe(9);
  });

  it("rounds a decimal to the nearest minute", () => {
    expect(parseMinutesInput("9,4", 600)).toBe(9);
    expect(parseMinutesInput("9.6", 600)).toBe(10);
  });

  it("is null for empty, garbage and out-of-range", () => {
    expect(parseMinutesInput("", 600)).toBeNull();
    expect(parseMinutesInput("скоро", 600)).toBeNull();
    expect(parseMinutesInput("0", 600)).toBeNull();
    expect(parseMinutesInput("601", 600)).toBeNull();
    expect(parseMinutesInput("-5", 600)).toBeNull();
  });
});

describe("minutes and seconds", () => {
  it("shows a timer in whole minutes", () => {
    expect(minutesFromSeconds(540)).toBe("9");
    expect(minutesFromSeconds(null)).toBe("");
  });

  it("never shows a sub-minute timer as «0»", () => {
    // «30 сек» rounds to 0 minutes, and a field reading «0» would look like
    // no timer at all — and would then be saved as one.
    expect(minutesFromSeconds(30)).toBe("1");
  });

  it("converts back to the seconds the column stores", () => {
    expect(secondsFromMinutes(9)).toBe(540);
    expect(secondsFromMinutes(null)).toBeNull();
  });
});
