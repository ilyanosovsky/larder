import { describe, expect, it } from "vitest";

import {
  canStepQty,
  defaultQtyFor,
  formatQtyNumber,
  parseTypedQty,
  qtyForUnitChange,
  QTY_STEP_BY_UNIT,
  qtyStepFor,
  STEPPER_MAX_QTY,
  stepQty,
} from "@/lib/cart/qty-step";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import { UNITS, type Unit } from "@/lib/units";

describe("QTY_STEP_BY_UNIT / qtyStepFor", () => {
  it("steps whole-item units by one", () => {
    for (const unit of ["шт", "уп", "пучок", "банка", "плитка"] as const) {
      expect(qtyStepFor(unit)).toBe(1);
    }
  });

  it("steps weight/volume units by a shelf-realistic grid, not by one", () => {
    // This table *is* the bug fix: before it, every unit stepped by 1, so
    // buying 250 g took 250 taps.
    expect(qtyStepFor("г")).toBe(50);
    expect(qtyStepFor("кг")).toBe(0.5);
    expect(qtyStepFor("мл")).toBe(50);
    expect(qtyStepFor("л")).toBe(0.5);
  });

  it("has an entry for every unit in the canon", () => {
    for (const unit of UNITS) {
      expect(QTY_STEP_BY_UNIT[unit]).toBeGreaterThan(0);
    }
  });

  it("never offers a step `addCartItemInput` would reject", () => {
    expect(STEPPER_MAX_QTY).toBe(MAX_QTY);
  });
});

describe("defaultQtyFor", () => {
  it("opens whole-item units at 1", () => {
    for (const unit of ["шт", "уп", "пучок", "банка", "плитка"] as const) {
      expect(defaultQtyFor(unit)).toBe(1);
    }
  });

  it("opens weight/volume units at a round shelf amount, not at their own step", () => {
    expect(defaultQtyFor("г")).toBe(100);
    expect(defaultQtyFor("кг")).toBe(1);
    expect(defaultQtyFor("мл")).toBe(100);
    expect(defaultQtyFor("л")).toBe(1);
  });
});

describe("stepQty", () => {
  it("moves a whole-item unit by one, same as before this fix", () => {
    expect(stepQty(2, 1, "шт")).toBe(3);
    expect(stepQty(2, -1, "шт")).toBe(1);
  });

  it("moves an on-grid weight value by exactly one step", () => {
    expect(stepQty(100, 1, "г")).toBe(150);
    expect(stepQty(100, -1, "г")).toBe(50);
  });

  it("snaps an off-grid typed value up to the next grid line on «+»", () => {
    // The brief's own example: 30 g is not a multiple of the 50 g step.
    expect(stepQty(30, 1, "г")).toBe(50);
    expect(stepQty(130, 1, "г")).toBe(150);
  });

  it("snaps an off-grid typed value down to the grid line below it on «−»", () => {
    expect(stepQty(130, -1, "г")).toBe(100);
  });

  it("leaves a below-floor typed value unchanged on «−», rather than raising it", () => {
    // 30 g is already below one whole step (50 g) — there is nowhere lower
    // on the grid to go. Snapping it *up* to the floor would make «−»,
    // labelled «Уменьшить количество», increase the value to the same
    // number «+» would reach — this is the bug Q5 fixes.
    expect(stepQty(30, -1, "г")).toBe(30);
  });

  it("never raises the value on «−», for any unit and any starting point on or off the grid", () => {
    for (const unit of UNITS satisfies readonly Unit[]) {
      const step = qtyStepFor(unit);
      // Halves and quotients of powers of two, so every start point is
      // exactly representable in binary floating point — a test that used
      // `step / 3` would fail on its own rounding, not on the code under
      // test.
      for (const start of [step / 2, step, step * 2.5, defaultQtyFor(unit)]) {
        expect(stepQty(start, -1, unit)).toBeLessThanOrEqual(start);
      }
    }
  });

  it("floors at one whole step of the unit, never at the storage minimum", () => {
    expect(stepQty(50, -1, "г")).toBe(50);
    expect(stepQty(0.5, -1, "кг")).toBe(0.5);
    expect(qtyStepFor("г")).toBeGreaterThan(MIN_QTY);
  });

  it("stops at the ceiling", () => {
    expect(stepQty(STEPPER_MAX_QTY, 1, "шт")).toBe(STEPPER_MAX_QTY);
    expect(stepQty(STEPPER_MAX_QTY - 10, 1, "г")).toBe(STEPPER_MAX_QTY);
  });

  it("treats a non-finite current value as 0 rather than propagating it", () => {
    expect(stepQty(Number.NaN, 1, "г")).toBe(50);
  });
});

describe("canStepQty", () => {
  it("reports when a control still has somewhere to go", () => {
    expect(canStepQty(2, -1, "шт")).toBe(true);
    expect(canStepQty(2, 1, "шт")).toBe(true);
  });

  it("disables «−» exactly at the floor", () => {
    expect(canStepQty(1, -1, "шт")).toBe(false);
    expect(canStepQty(50, -1, "г")).toBe(false);
    expect(canStepQty(0.5, -1, "кг")).toBe(false);
  });

  it("disables «−» on a below-floor value too — raising it is not «somewhere to go»", () => {
    // Q5: `stepQty` no longer snaps a below-floor value up to the floor (that
    // made «Уменьшить количество» increase the number), so `canStepQty` must
    // agree that «−» has nothing left to do here.
    expect(canStepQty(30, -1, "г")).toBe(false);
  });

  it("disables at the ceiling", () => {
    expect(canStepQty(STEPPER_MAX_QTY, 1, "шт")).toBe(false);
  });
});

describe("parseTypedQty", () => {
  it("parses a plain integer", () => {
    expect(parseTypedQty("250", "г")).toBe(250);
  });

  it("accepts a comma decimal — the on-screen keyboard's own separator", () => {
    expect(parseTypedQty("0,5", "кг")).toBe(0.5);
  });

  it("accepts a dot decimal too", () => {
    expect(parseTypedQty("0.5", "кг")).toBe(0.5);
  });

  it("strips Russian thousands grouping", () => {
    expect(parseTypedQty("1 500", "г")).toBe(1500);
  });

  it("trims surrounding whitespace", () => {
    expect(parseTypedQty("  250  ", "г")).toBe(250);
  });

  it("rejects empty input", () => {
    expect(parseTypedQty("", "г")).toBeNull();
    expect(parseTypedQty("   ", "г")).toBeNull();
  });

  it("rejects anything that is not a number", () => {
    expect(parseTypedQty("abc", "г")).toBeNull();
    expect(parseTypedQty("12,5,3", "г")).toBeNull();
    expect(parseTypedQty("-5", "г")).toBeNull();
    expect(parseTypedQty("1e5", "г")).toBeNull();
  });

  it("rejects zero and negative quantities", () => {
    expect(parseTypedQty("0", "г")).toBeNull();
    expect(parseTypedQty("0,0", "кг")).toBeNull();
  });

  it("allows a fractional value below one whole step — the stepper's own floor does not apply here", () => {
    expect(parseTypedQty("0,3", "кг")).toBe(0.3);
    expect(qtyStepFor("кг")).toBeGreaterThan(0.3);
  });

  it("rounds a whole-item unit to the nearest integer instead of accepting a fraction", () => {
    expect(parseTypedQty("2,5", "шт")).toBe(3);
    expect(parseTypedQty("2,4", "шт")).toBe(2);
  });

  it("rejects a whole-item typed value that rounds down to zero", () => {
    expect(parseTypedQty("0,4", "шт")).toBeNull();
  });

  it("rounds to the storage scale, same as `roundQty`", () => {
    expect(parseTypedQty("0,1234", "кг")).toBe(0.123);
  });

  it("clamps to the router's own bounds", () => {
    expect(parseTypedQty(String(MAX_QTY + 1), "г")).toBe(MAX_QTY);
  });

  it("rounds typed values to whole items exactly for the units that step by one", () => {
    // `DISCRETE_UNITS` (the hand-maintained set that decides whether a typed
    // «2,5» rounds to 2 or 3, vs stays 2.5) is not itself exported or tested
    // directly — this pins the partition it actually implements against the
    // one table the compiler already keeps complete (`QTY_STEP_BY_UNIT`), so
    // a unit accidentally dropped from `DISCRETE_UNITS` fails here instead of
    // shipping green.
    for (const unit of UNITS satisfies readonly Unit[]) {
      const parsed = parseTypedQty("2,5", unit);
      expect(Number.isInteger(parsed)).toBe(qtyStepFor(unit) === 1);
    }
  });
});

describe("qtyForUnitChange", () => {
  it("keeps the value when the unit does not change", () => {
    expect(qtyForUnitChange(250, "г", "г")).toBe(250);
  });

  it("switches to the new unit's default when the line is still untouched", () => {
    expect(qtyForUnitChange(defaultQtyFor("г"), "г", "кг")).toBe(
      defaultQtyFor("кг"),
    );
  });

  it("keeps a value the shopper actually set, across a unit change", () => {
    // A person who typed 250 and then switched г → кг meant *their* number,
    // not «250 kg» — reinterpreting it would be a guess this module has no
    // basis for.
    expect(qtyForUnitChange(250, "г", "кг")).toBe(250);
  });

  it("keeps a stepped-away-from-default value too", () => {
    const stepped = stepQty(defaultQtyFor("г"), 1, "г");
    expect(stepped).not.toBe(defaultQtyFor("г"));
    expect(qtyForUnitChange(stepped, "г", "кг")).toBe(stepped);
  });
});

describe("formatQtyNumber", () => {
  it("uses a comma decimal and no grouping", () => {
    expect(formatQtyNumber(0.5)).toBe("0,5");
    expect(formatQtyNumber(250)).toBe("250");
    expect(formatQtyNumber(1500)).toBe("1500");
  });
});

describe("every unit is covered end to end", () => {
  it("opens with a default that «+» can always move up from", () => {
    for (const unit of UNITS satisfies readonly Unit[]) {
      const start = defaultQtyFor(unit);
      expect(stepQty(start, 1, unit)).toBeGreaterThan(start);
    }
  });

  it("opens with a default at or above the unit's own floor", () => {
    for (const unit of UNITS satisfies readonly Unit[]) {
      expect(defaultQtyFor(unit)).toBeGreaterThanOrEqual(qtyStepFor(unit));
    }
  });
});
