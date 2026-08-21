import { describe, expect, it } from "vitest";

import {
  canStepQty,
  clampQty,
  QTY_STEP,
  stepQty,
  STEPPER_MAX_QTY,
  STEPPER_MIN_QTY,
} from "@/lib/cart/qty-step";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";

describe("stepper bounds", () => {
  it("never offers a quantity `addCartItemInput` would reject", () => {
    // Pinned against the router's own constants rather than copied numbers:
    // widening `qtyField` must not silently leave the stepper behind, and
    // narrowing it must break here rather than at the shelf.
    expect(STEPPER_MIN_QTY).toBeGreaterThanOrEqual(MIN_QTY);
    expect(STEPPER_MAX_QTY).toBe(MAX_QTY);
  });

  it("floors at one whole unit, not at the column's own minimum", () => {
    expect(STEPPER_MIN_QTY).toBe(1);
    expect(MIN_QTY).toBeLessThan(1);
  });
});

describe("stepQty", () => {
  it("adds and subtracts one step", () => {
    expect(stepQty(2, QTY_STEP)).toBe(3);
    expect(stepQty(2, -QTY_STEP)).toBe(1);
  });

  it("stops at the floor instead of walking below it", () => {
    expect(stepQty(1, -QTY_STEP)).toBe(STEPPER_MIN_QTY);
  });

  it("stops at the ceiling", () => {
    expect(stepQty(STEPPER_MAX_QTY, QTY_STEP)).toBe(STEPPER_MAX_QTY);
  });
});

describe("clampQty", () => {
  it("passes an in-range quantity through", () => {
    expect(clampQty(7)).toBe(7);
  });

  it("pulls anything out of range back in", () => {
    expect(clampQty(0)).toBe(STEPPER_MIN_QTY);
    expect(clampQty(-3)).toBe(STEPPER_MIN_QTY);
    expect(clampQty(STEPPER_MAX_QTY + 1)).toBe(STEPPER_MAX_QTY);
  });

  it("collapses NaN to the floor rather than propagating it", () => {
    // `Math.min`/`Math.max` would hand `NaN` straight through to `cart.add`,
    // which rejects it with a validation error nobody at the shelf can act on.
    expect(clampQty(Number.NaN)).toBe(STEPPER_MIN_QTY);
  });

  it("clamps infinities to the nearer bound", () => {
    expect(clampQty(Number.POSITIVE_INFINITY)).toBe(STEPPER_MAX_QTY);
    expect(clampQty(Number.NEGATIVE_INFINITY)).toBe(STEPPER_MIN_QTY);
  });
});

describe("canStepQty", () => {
  it("reports when a control still has somewhere to go", () => {
    expect(canStepQty(2, -QTY_STEP)).toBe(true);
    expect(canStepQty(2, QTY_STEP)).toBe(true);
  });

  it("reports when it does not", () => {
    expect(canStepQty(STEPPER_MIN_QTY, -QTY_STEP)).toBe(false);
    expect(canStepQty(STEPPER_MAX_QTY, QTY_STEP)).toBe(false);
  });
});
