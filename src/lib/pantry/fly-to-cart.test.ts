import { describe, expect, it } from "vitest";

import { flyToCartDelta } from "@/lib/pantry/fly-to-cart";

describe("flyToCartDelta", () => {
  it("computes the translation between the two rects' centres", () => {
    const from = { left: 10, top: 20, width: 100, height: 40 }; // centre (60, 40)
    const to = { left: 200, top: 300, width: 50, height: 50 }; // centre (225, 325)

    expect(flyToCartDelta(from, to)).toEqual({
      left: 10,
      top: 20,
      dx: 165,
      dy: 285,
    });
  });

  it("returns a zero delta for identical rects", () => {
    const rect = { left: 0, top: 0, width: 20, height: 20 };

    expect(flyToCartDelta(rect, rect)).toEqual({
      left: 0,
      top: 0,
      dx: 0,
      dy: 0,
    });
  });

  it("keeps the origin at from's own top-left, independent of the delta", () => {
    const from = { left: 42, top: 7, width: 10, height: 10 };
    const to = { left: 0, top: 0, width: 10, height: 10 };

    const delta = flyToCartDelta(from, to);
    expect(delta.left).toBe(42);
    expect(delta.top).toBe(7);
  });

  it("handles the destination sitting above and to the left of the origin", () => {
    // «Кончилось» is tapped somewhere lower in the list than the segment
    // control it flies toward — dx/dy should come out negative.
    const from = { left: 100, top: 400, width: 40, height: 20 };
    const to = { left: 20, top: 40, width: 60, height: 30 };

    const delta = flyToCartDelta(from, to);
    expect(delta.dx).toBeLessThan(0);
    expect(delta.dy).toBeLessThan(0);
  });
});
