import { describe, expect, it } from "vitest";

import { pickNextFocusTarget } from "@/lib/pantry/next-focus-target";

const A = { id: "a" };
const B = { id: "b" };
const C = { id: "c" };

describe("pickNextFocusTarget", () => {
  it("picks the following row when one exists", () => {
    expect(pickNextFocusTarget([A, B, C], "a")).toBe("b");
    expect(pickNextFocusTarget([A, B, C], "b")).toBe("c");
  });

  it("falls back to the previous row for the last row in the list", () => {
    expect(pickNextFocusTarget([A, B, C], "c")).toBe("b");
  });

  it("falls back to the previous row when it is the very first pair", () => {
    expect(pickNextFocusTarget([A, B], "b")).toBe("a");
  });

  it("returns null when the removed row was the only one in the list", () => {
    expect(pickNextFocusTarget([A], "a")).toBeNull();
  });

  it("returns null when the removed id is not in the list at all", () => {
    // Defensive: a stale call after the list has already moved on.
    expect(pickNextFocusTarget([A, B], "missing")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickNextFocusTarget([], "a")).toBeNull();
  });
});
