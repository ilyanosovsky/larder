import { describe, expect, it } from "vitest";

import { decideStepSwipe } from "@/lib/cooking/step-swipe";

describe("decideStepSwipe", () => {
  it("springs back for a small, slow drag below both thresholds", () => {
    expect(
      decideStepSwipe({ dx: 10, dy: 0, recentDx: 10, recentElapsedMs: 400 }),
    ).toBeNull();
  });

  it("commits «next» once the distance threshold is crossed to the left", () => {
    expect(
      decideStepSwipe({
        dx: -120,
        dy: 0,
        recentDx: -120,
        recentElapsedMs: 500,
      }),
    ).toBe("next");
  });

  it("commits «prev» once the distance threshold is crossed to the right", () => {
    expect(
      decideStepSwipe({ dx: 120, dy: 0, recentDx: 120, recentElapsedMs: 500 }),
    ).toBe("prev");
  });

  it("does not commit one px short of the distance threshold", () => {
    expect(
      decideStepSwipe({ dx: -95, dy: 0, recentDx: -95, recentElapsedMs: 500 }),
    ).toBeNull();
  });

  it("commits exactly at the distance threshold", () => {
    expect(
      decideStepSwipe({ dx: -96, dy: 0, recentDx: -96, recentElapsedMs: 500 }),
    ).toBe("next");
  });

  it("commits a fast short flick even under the distance threshold", () => {
    expect(
      decideStepSwipe({ dx: -40, dy: 0, recentDx: -40, recentElapsedMs: 50 }),
    ).toBe("next");
  });

  it("does not commit a fast but tiny jitter under the fling distance floor", () => {
    expect(
      decideStepSwipe({ dx: -10, dy: 0, recentDx: -10, recentElapsedMs: 5 }),
    ).toBeNull();
  });

  it("never commits a drag that moved more vertically than horizontally", () => {
    expect(
      decideStepSwipe({
        dx: 100,
        dy: 150,
        recentDx: 100,
        recentElapsedMs: 300,
      }),
    ).toBeNull();
  });

  it("never commits a fling on a reversal that ends back at the origin", () => {
    expect(
      decideStepSwipe({ dx: 0, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  it("handles a zero-duration recent window without dividing by zero", () => {
    expect(
      decideStepSwipe({ dx: -120, dy: 0, recentDx: -120, recentElapsedMs: 0 }),
    ).toBe("next");
    expect(
      decideStepSwipe({ dx: -10, dy: 0, recentDx: -10, recentElapsedMs: 0 }),
    ).toBeNull();
  });

  it("does not commit a perfectly still release", () => {
    expect(
      decideStepSwipe({ dx: 0, dy: 0, recentDx: 0, recentElapsedMs: 300 }),
    ).toBeNull();
  });

  // ── Fling direction must agree with the drag's own total displacement
  // (CodeRabbit finding on this PR): a drag left followed by a flick right
  // that never quite crosses back past the origin clears the fling floors
  // on the flick's own magnitude, but must not then commit backwards in
  // `dx`'s direction. ──

  it("does not commit a fling whose recent direction disagrees with the drag's total direction", () => {
    // Dragged left 30px, then flicked right 40px in the last 50ms — the
    // *net* displacement is still left (`dx: -30`), but the actual last
    // motion was rightward. Committing "prev" (from `dx`'s sign) would be
    // backwards from what just happened; springing back is correct.
    expect(
      decideStepSwipe({ dx: -30, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  it("still commits a fling whose recent direction agrees with the drag's own", () => {
    expect(
      decideStepSwipe({ dx: -30, dy: 0, recentDx: -40, recentElapsedMs: 50 }),
    ).toBe("next");
  });
});
