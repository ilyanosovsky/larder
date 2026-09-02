import { describe, expect, it } from "vitest";

import {
  ingredientsYieldUnit,
  parsePortions,
  portionsDisplay,
} from "./portions";

describe("parsePortions", () => {
  it("reads a bare number", () => {
    expect(parsePortions("8")).toEqual({ base: 8, min: null });
  });

  it("reads a range as base = upper bound, min = lower", () => {
    // The quantities in the source belong to the batch it actually makes.
    expect(parsePortions("7–8")).toEqual({ base: 8, min: 7 });
    expect(parsePortions("7-8 порций")).toEqual({ base: 8, min: 7 });
    expect(parsePortions("7 — 8 печений")).toEqual({ base: 8, min: 7 });
  });

  it("ignores the words around the number", () => {
    expect(parsePortions("на 4")).toEqual({ base: 4, min: null });
    expect(parsePortions("Порций: 4")).toEqual({ base: 4, min: null });
    expect(parsePortions("4 порции")).toEqual({ base: 4, min: null });
  });

  it("drops a range whose ends are equal — «8–8» is «8»", () => {
    expect(parsePortions("8–8")).toEqual({ base: 8, min: null });
  });

  it("orders a backwards range instead of trusting its order", () => {
    expect(parsePortions("8–7")).toEqual({ base: 8, min: 7 });
  });

  it("refuses garbage rather than guessing", () => {
    expect(parsePortions("много")).toBeNull();
    expect(parsePortions("")).toBeNull();
    expect(parsePortions("—")).toBeNull();
  });

  it("refuses a number that cannot be a portion count", () => {
    expect(parsePortions("0")).toBeNull();
    expect(parsePortions("205 °C")).toBeNull();
    // «2026» is one impossible number, not «202» and a plausible «6».
    expect(parsePortions("2026")).toBeNull();
  });

  it("falls back to the single number when only one end of a range is sane", () => {
    // «0-8» is not a range; the 8 still is a portion count.
    expect(parsePortions("0-8")).toEqual({ base: 8, min: null });
  });
});

describe("portionsDisplay", () => {
  it("is a single count when no range was stated", () => {
    expect(
      portionsDisplay({ portionsBase: 8, portionsMin: null, yieldUnit: null }),
    ).toEqual({ kind: "single", count: 8, unit: null });
  });

  it("is a range when a lower bound sits below the base", () => {
    expect(
      portionsDisplay({
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: "печений",
      }),
    ).toEqual({ kind: "range", from: 7, to: 8, unit: "печений" });
  });

  it("degrades a nonsensical lower bound to a single count", () => {
    // The draft schema refuses these, but the column has held rows since
    // before that schema existed as far as this function is concerned.
    expect(
      portionsDisplay({ portionsBase: 8, portionsMin: 8, yieldUnit: null }),
    ).toEqual({ kind: "single", count: 8, unit: null });
    expect(
      portionsDisplay({ portionsBase: 8, portionsMin: 9, yieldUnit: null }),
    ).toEqual({ kind: "single", count: 8, unit: null });
  });

  it("treats a blank yield noun as none — «порции» comes from next-intl", () => {
    expect(
      portionsDisplay({ portionsBase: 2, portionsMin: null, yieldUnit: "   " }),
    ).toEqual({ kind: "single", count: 2, unit: null });
  });

  it("trims the stored noun", () => {
    expect(
      portionsDisplay({ portionsBase: 8, portionsMin: null, yieldUnit: " шт " }),
    ).toEqual({ kind: "single", count: 8, unit: "шт" });
  });
});

describe("ingredientsYieldUnit", () => {
  it("keeps the stored noun for a ranged yield — the S7 regression", () => {
    // «7–8 печений» above the list, so the list itself must say «на 8
    // печений», never «на 8 порций».
    expect(
      ingredientsYieldUnit({
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: "печений",
      }),
    ).toBe("печений");
  });

  it("keeps it for a single yield too", () => {
    expect(
      ingredientsYieldUnit({
        portionsBase: 8,
        portionsMin: null,
        yieldUnit: "печений",
      }),
    ).toBe("печений");
  });

  it("is null when the source stated no noun — next-intl says «порций»", () => {
    expect(
      ingredientsYieldUnit({
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: null,
      }),
    ).toBeNull();
    expect(
      ingredientsYieldUnit({
        portionsBase: 2,
        portionsMin: null,
        yieldUnit: "  ",
      }),
    ).toBeNull();
  });
});
