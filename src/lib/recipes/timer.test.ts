import { describe, expect, it } from "vitest";

import { timerDisplay } from "./timer";

describe("timerDisplay", () => {
  it("is null for a step with no timer", () => {
    expect(timerDisplay(null, null)).toBeNull();
    expect(timerDisplay(null, 660)).toBeNull();
  });

  it("renders the design's own «9–11 мин» step", () => {
    expect(timerDisplay(540, 660)).toEqual({
      kind: "range",
      unit: "min",
      from: 9,
      to: 11,
    });
  });

  it("keeps a sub-minute timer in seconds rather than rounding it to «0 мин»", () => {
    expect(timerDisplay(1, null)).toEqual({
      kind: "single",
      unit: "sec",
      value: 1,
    });
    expect(timerDisplay(29, null)).toEqual({
      kind: "single",
      unit: "sec",
      value: 29,
    });
    expect(timerDisplay(30, null)).toEqual({
      kind: "single",
      unit: "sec",
      value: 30,
    });
    expect(timerDisplay(59, null)).toEqual({
      kind: "single",
      unit: "sec",
      value: 59,
    });
  });

  it("switches to minutes at exactly a minute", () => {
    expect(timerDisplay(60, null)).toEqual({
      kind: "single",
      unit: "min",
      value: 1,
    });
  });

  it("keeps a sub-minute range in seconds", () => {
    expect(timerDisplay(20, 40)).toEqual({
      kind: "range",
      unit: "sec",
      from: 20,
      to: 40,
    });
  });

  it("floors the minute value at 1 when the lower bound would round to zero", () => {
    // «20–90 сек» must not read «0–2 мин».
    expect(timerDisplay(20, 90)).toEqual({
      kind: "range",
      unit: "min",
      from: 1,
      to: 2,
    });
  });

  it("collapses a range whose bounds round to the same number", () => {
    expect(timerDisplay(540, 560)).toEqual({
      kind: "single",
      unit: "min",
      value: 9,
    });
  });

  it("drops an upper bound that is not above the lower one", () => {
    // The column has no CHECK, so a row can hold what the draft schema refuses.
    expect(timerDisplay(660, 540)).toEqual({
      kind: "single",
      unit: "min",
      value: 11,
    });
    expect(timerDisplay(540, 540)).toEqual({
      kind: "single",
      unit: "min",
      value: 9,
    });
  });

  it("refuses a nonsensical lower bound instead of printing it", () => {
    expect(timerDisplay(0, 660)).toBeNull();
    expect(timerDisplay(-5, null)).toBeNull();
    expect(timerDisplay(Number.NaN, null)).toBeNull();
  });

  it("rounds to the nearest minute above the boundary", () => {
    expect(timerDisplay(90, null)).toEqual({
      kind: "single",
      unit: "min",
      value: 2,
    });
    expect(timerDisplay(89, null)).toEqual({
      kind: "single",
      unit: "min",
      value: 1,
    });
  });
});
