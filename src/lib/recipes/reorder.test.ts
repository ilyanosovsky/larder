import { describe, expect, it } from "vitest";

import { moveItem, stepDropIndex } from "@/lib/recipes/reorder";

const STEPS = ["a", "b", "c", "d"];

describe("moveItem", () => {
  it("moves an item down", () => {
    expect(moveItem(STEPS, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up", () => {
    expect(moveItem(STEPS, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("is identity for from === to", () => {
    expect(moveItem(STEPS, 2, 2)).toEqual(STEPS);
  });

  it("never mutates its input", () => {
    const original = [...STEPS];
    const moved = moveItem(original, 0, 3);

    expect(original).toEqual(STEPS);
    expect(moved).not.toBe(original);
    // A spliced-in-place array is the same reference React already rendered.
    expect(moveItem(STEPS, 1, 1)).not.toBe(STEPS);
  });

  it("clamps an out-of-range target to the ends", () => {
    expect(moveItem(STEPS, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(STEPS, 3, -5)).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps an out-of-range source too", () => {
    expect(moveItem(STEPS, 99, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("survives an empty list", () => {
    expect(moveItem([], 0, 1)).toEqual([]);
  });

  it("agrees with the «Выше»/«Ниже» buttons, which are the same call", () => {
    // The keyboard path is `moveItem(list, index, index ± 1)`; a pointer drop
    // that lands on the neighbouring row must produce the identical array.
    const rects = [
      { top: 0, height: 40 },
      { top: 40, height: 40 },
      { top: 80, height: 40 },
      { top: 120, height: 40 },
    ];
    const dropped = stepDropIndex(95, rects);

    expect(dropped).toBe(2);
    expect(moveItem(STEPS, 1, dropped)).toEqual(moveItem(STEPS, 1, 1 + 1));
  });
});

describe("stepDropIndex", () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it("lands on the first row above every midpoint", () => {
    expect(stepDropIndex(-100, rects)).toBe(0);
    expect(stepDropIndex(0, rects)).toBe(0);
    expect(stepDropIndex(19, rects)).toBe(0);
  });

  it("swaps only once the pointer is past a row's middle", () => {
    expect(stepDropIndex(20, rects)).toBe(1);
    expect(stepDropIndex(59, rects)).toBe(1);
    expect(stepDropIndex(60, rects)).toBe(2);
  });

  it("clamps below the last row instead of running off the end", () => {
    // `rects.length` would be a valid splice position but not a valid final
    // index, and `moveItem` would then quietly clamp it anyway.
    expect(stepDropIndex(1000, rects)).toBe(2);
  });

  it("is 0 for an empty list", () => {
    expect(stepDropIndex(50, [])).toBe(0);
  });

  it("never answers NaN for a pointer with no coordinate", () => {
    expect(stepDropIndex(Number.NaN, rects)).toBe(0);
  });
});
