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

  it("lands where «Ниже» lands when the drag crosses one row", () => {
    // «Ниже» on index 1 is `moveItem(list, 1, 2)` — this is the array it
    // produces, named literally so the assertion cannot agree with itself.
    expect(moveItem(STEPS, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveItem(STEPS, 1, drop(110, 1))).toEqual(["a", "c", "b", "d"]);
  });
});

/** Rows 40px tall at 0/40/80/120 — midpoints 20, 60, 100, 140. */
const RECTS = [
  { top: 0, height: 40 },
  { top: 40, height: 40 },
  { top: 80, height: 40 },
  { top: 120, height: 40 },
];

/** What the form does: geometry in, `moveItem` target out. */
function drop(pointerY: number, from: number): number {
  return stepDropIndex(pointerY, RECTS, from);
}

/** The whole gesture, end to end — the only assertion that can catch F1. */
function dragTo(from: number, pointerY: number): string[] {
  return moveItem(STEPS, from, drop(pointerY, from));
}

describe("a released drag, end to end", () => {
  // Asserting the resulting array literally, never `moveItem(list, from, x)`
  // against `moveItem(list, from, y)` — two calls to the same function with
  // the same arguments agree no matter what either of them computes, which is
  // exactly how an off-by-one in the gap→index conversion shipped green.

  it("drops one row down when the pointer passes that row's middle", () => {
    // Row 1 spans 40..80; its lower half starts at its midpoint, 60.
    expect(dragTo(0, 70)).toEqual(["b", "a", "c", "d"]);
  });

  it("changes nothing while the pointer is still inside the dragged row", () => {
    // Row 0 spans 0..40. Anywhere in it — including past its own midpoint —
    // is a drag that has not reached anywhere else yet.
    expect(dragTo(0, 5)).toEqual(STEPS);
    expect(dragTo(0, 25)).toEqual(STEPS);
    expect(dragTo(2, 90)).toEqual(STEPS);
  });

  it("drops to the end when the pointer is released below the last row", () => {
    expect(dragTo(0, 150)).toEqual(["b", "c", "d", "a"]);
    expect(dragTo(0, 10_000)).toEqual(["b", "c", "d", "a"]);
  });

  it("drops to the start when the pointer is released above the first row", () => {
    expect(dragTo(3, -50)).toEqual(["d", "a", "b", "c"]);
  });

  it("moves up one row when the pointer reaches that row's upper half", () => {
    // Row 2 spans 80..120; its upper half is 80..100.
    expect(dragTo(3, 90)).toEqual(["a", "b", "d", "c"]);
  });

  it("moves up two rows when the pointer reaches the row above that", () => {
    expect(dragTo(3, 50)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves down two rows when the pointer passes two midpoints", () => {
    // y = 110 is inside row 2 (80..120) and past its midpoint (100), so the
    // dragged row takes row 2's place — not the position below it.
    expect(dragTo(0, 110)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("stepDropIndex", () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it("lands on the first row above every midpoint", () => {
    expect(stepDropIndex(-100, rects, 2)).toBe(0);
    expect(stepDropIndex(0, rects, 2)).toBe(0);
    expect(stepDropIndex(19, rects, 2)).toBe(0);
  });

  it("swaps only once the pointer is past a row's middle", () => {
    expect(stepDropIndex(20, rects, 2)).toBe(1);
    expect(stepDropIndex(59, rects, 2)).toBe(1);
    expect(stepDropIndex(60, rects, 2)).toBe(2);
  });

  it("shifts a downward drag down by one, because moveItem removes first", () => {
    // Dragging row 0 with the pointer past two midpoints sits in gap 2 of the
    // list as drawn, which is index 1 once row 0 has been lifted out.
    expect(stepDropIndex(70, rects, 0)).toBe(1);
    // The same pointer position for an upward drag needs no shift.
    expect(stepDropIndex(70, rects, 2)).toBe(2);
  });

  it("reaches the last index when the pointer is below the last row", () => {
    expect(stepDropIndex(1000, rects, 0)).toBe(2);
    expect(stepDropIndex(1000, rects, 2)).toBe(2);
  });

  it("is 0 for an empty list", () => {
    expect(stepDropIndex(50, [], 0)).toBe(0);
  });

  it("never answers NaN for a pointer with no coordinate", () => {
    expect(stepDropIndex(Number.NaN, rects, 0)).toBe(0);
  });

  it("survives a source index that is not a real row", () => {
    expect(stepDropIndex(1000, rects, Number.NaN)).toBe(2);
    expect(stepDropIndex(1000, rects, 99)).toBe(2);
  });
});
