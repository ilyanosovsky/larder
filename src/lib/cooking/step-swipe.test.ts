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
});
