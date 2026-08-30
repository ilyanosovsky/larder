import { describe, expect, it } from "vitest";

import { decideSwipeCommit } from "@/lib/pantry/swipe-commit";

describe("decideSwipeCommit", () => {
  it("springs back for a small, slow drag below both thresholds", () => {
    expect(decideSwipeCommit({ dx: 10, dy: 0, elapsedMs: 400 })).toBeNull();
  });

  it("commits «have» once the distance threshold is crossed to the right", () => {
    expect(decideSwipeCommit({ dx: 120, dy: 0, elapsedMs: 500 })).toBe("have");
  });

  it("commits «ranOut» once the distance threshold is crossed to the left", () => {
    expect(decideSwipeCommit({ dx: -120, dy: 0, elapsedMs: 500 })).toBe(
      "ranOut",
    );
  });

  it("does not commit right at the distance floor minus one", () => {
    expect(decideSwipeCommit({ dx: 95, dy: 0, elapsedMs: 500 })).toBeNull();
  });

  it("commits exactly at the distance threshold", () => {
    expect(decideSwipeCommit({ dx: 96, dy: 0, elapsedMs: 500 })).toBe("have");
  });

  it("commits a fast short flick even under the distance threshold", () => {
    // 40px in 50ms = 0.8 px/ms, above the fling velocity floor.
    expect(decideSwipeCommit({ dx: 40, dy: 0, elapsedMs: 50 })).toBe("have");
  });

  it("does not commit a fast but tiny jitter under the fling distance floor", () => {
    // 10px in 5ms = 2 px/ms — fast, but too short a distance to count as a
    // deliberate flick rather than a shaky lift-off.
    expect(decideSwipeCommit({ dx: 10, dy: 0, elapsedMs: 5 })).toBeNull();
  });

  it("does not commit a slow drag that crossed the fling distance floor but not the velocity floor", () => {
    // 40px in 200ms = 0.2 px/ms, below the fling velocity floor and below
    // the full distance threshold.
    expect(decideSwipeCommit({ dx: 40, dy: 0, elapsedMs: 200 })).toBeNull();
  });

  it("never commits a drag that moved more vertically than horizontally", () => {
    expect(decideSwipeCommit({ dx: 100, dy: 150, elapsedMs: 300 })).toBeNull();
  });

  it("treats equal horizontal and vertical movement as not-horizontal-enough", () => {
    expect(decideSwipeCommit({ dx: 100, dy: 100, elapsedMs: 300 })).toBe(
      "have",
    );
  });

  it("handles a zero-duration release without dividing by zero", () => {
    expect(decideSwipeCommit({ dx: 120, dy: 0, elapsedMs: 0 })).toBe("have");
    expect(decideSwipeCommit({ dx: 10, dy: 0, elapsedMs: 0 })).toBeNull();
  });

  it("does not commit a perfectly still release", () => {
    expect(decideSwipeCommit({ dx: 0, dy: 0, elapsedMs: 300 })).toBeNull();
  });
});
