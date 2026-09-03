import { describe, expect, it } from "vitest";

import { timerState } from "@/lib/recipes/timer";

import {
  blockingTimerStepIndex,
  needsExitConfirmation,
  restoreCookingState,
  stepNavigation,
} from "./steps";

describe("stepNavigation", () => {
  it("advances and retreats within range", () => {
    expect(stepNavigation(2, 6, { type: "next" })).toBe(3);
    expect(stepNavigation(2, 6, { type: "prev" })).toBe(1);
  });

  it("clamps «next» at the last step", () => {
    expect(stepNavigation(5, 6, { type: "next" })).toBe(5);
  });

  it("clamps «prev» at the first step", () => {
    expect(stepNavigation(0, 6, { type: "prev" })).toBe(0);
  });

  it("«goto» clamps an out-of-range target at both ends", () => {
    expect(stepNavigation(2, 6, { type: "goto", index: 99 })).toBe(5);
    expect(stepNavigation(2, 6, { type: "goto", index: -4 })).toBe(0);
  });

  it("«goto» passes an in-range target through unchanged", () => {
    expect(stepNavigation(2, 6, { type: "goto", index: 4 })).toBe(4);
  });

  it("a dish with no steps always stays at 0", () => {
    expect(stepNavigation(0, 0, { type: "next" })).toBe(0);
    expect(stepNavigation(0, 0, { type: "goto", index: 3 })).toBe(0);
  });

  it("a single-step recipe clamps both directions to 0", () => {
    expect(stepNavigation(0, 1, { type: "next" })).toBe(0);
    expect(stepNavigation(0, 1, { type: "prev" })).toBe(0);
  });
});

describe("needsExitConfirmation", () => {
  it("does not gate leaving from the first step with no timer ever started", () => {
    expect(needsExitConfirmation(0, null)).toBe(false);
  });

  it("gates leaving past the first step, timer or not", () => {
    expect(needsExitConfirmation(1, null)).toBe(true);
    expect(needsExitConfirmation(3, "finished")).toBe(true);
  });

  it("gates leaving the first step while a timer is actually running", () => {
    expect(needsExitConfirmation(0, "running")).toBe(true);
  });

  it("does not gate the first step once the timer has already finished", () => {
    // Nothing left to lose — the countdown already rang.
    expect(needsExitConfirmation(0, "finished")).toBe(false);
  });
});

describe("blockingTimerStepIndex", () => {
  it("blocks nothing when no timer was ever started", () => {
    expect(blockingTimerStepIndex(null, 2, null)).toBeNull();
  });

  it("blocks nothing on the step the running timer itself belongs to", () => {
    expect(
      blockingTimerStepIndex({ endsAt: 1_000, stepIndex: 2 }, 2, "running"),
    ).toBeNull();
  });

  it("blocks a different step while the timer is running", () => {
    expect(
      blockingTimerStepIndex({ endsAt: 1_000, stepIndex: 2 }, 4, "running"),
    ).toBe(2);
  });

  it("does not block a different step once the timer has finished", () => {
    // The bug this function fixes: a rung timer must not keep every other
    // step's start button inert with a "still cooking" hint that is no
    // longer true.
    expect(
      blockingTimerStepIndex({ endsAt: 1_000, stepIndex: 2 }, 4, "finished"),
    ).toBeNull();
  });

  it("does not block the timer's own step even once finished", () => {
    expect(
      blockingTimerStepIndex({ endsAt: 1_000, stepIndex: 2 }, 2, "finished"),
    ).toBeNull();
  });
});

describe("restoreCookingState", () => {
  it("returns fresh state for garbage input", () => {
    expect(restoreCookingState(null, 6)).toEqual({
      stepIndex: 0,
      timer: null,
    });
    expect(restoreCookingState(undefined, 6)).toEqual({
      stepIndex: 0,
      timer: null,
    });
    expect(restoreCookingState("not an object", 6)).toEqual({
      stepIndex: 0,
      timer: null,
    });
    expect(restoreCookingState(42, 6)).toEqual({ stepIndex: 0, timer: null });
    expect(restoreCookingState([1, 2, 3], 6)).toEqual({
      stepIndex: 0,
      timer: null,
    });
  });

  it("returns fresh state when the recipe has no steps at all", () => {
    expect(
      restoreCookingState({ stepIndex: 2, timer: { endsAt: 5_000 } }, 0),
    ).toEqual({ stepIndex: 0, timer: null });
  });

  it("round-trips a valid, fully-shaped persisted state", () => {
    expect(
      restoreCookingState(
        { stepIndex: 3, timer: { endsAt: 123_456, stepIndex: 3 } },
        6,
      ),
    ).toEqual({ stepIndex: 3, timer: { endsAt: 123_456, stepIndex: 3 } });
  });

  it("degrades a non-numeric stepIndex to 0, independently of a valid timer", () => {
    expect(
      restoreCookingState(
        { stepIndex: "two", timer: { endsAt: 5_000, stepIndex: 1 } },
        6,
      ),
    ).toEqual({ stepIndex: 0, timer: { endsAt: 5_000, stepIndex: 1 } });
  });

  it("degrades a malformed timer to null, independently of a valid stepIndex", () => {
    expect(restoreCookingState({ stepIndex: 2, timer: "soon" }, 6)).toEqual({
      stepIndex: 2,
      timer: null,
    });
    expect(
      restoreCookingState({ stepIndex: 2, timer: { endsAt: "soon" } }, 6),
    ).toEqual({ stepIndex: 2, timer: null });
  });

  it("treats a missing timer field as no timer, not garbage", () => {
    expect(restoreCookingState({ stepIndex: 1 }, 6)).toEqual({
      stepIndex: 1,
      timer: null,
    });
  });

  it("clamps both stepIndex and timer.stepIndex to the recipe's own bounds", () => {
    expect(
      restoreCookingState(
        { stepIndex: 99, timer: { endsAt: 5_000, stepIndex: -3 } },
        6,
      ),
    ).toEqual({ stepIndex: 5, timer: { endsAt: 5_000, stepIndex: 0 } });
  });

  it("keeps a restored past endsAt as-is — timerState is what reports «finished»", () => {
    const nowMs = 10 * 60_000;
    const pastEndsAt = 60_000; // long before `nowMs`

    const restored = restoreCookingState(
      { stepIndex: 2, timer: { endsAt: pastEndsAt, stepIndex: 2 } },
      6,
    );

    expect(restored.timer).toEqual({ endsAt: pastEndsAt, stepIndex: 2 });
    expect(timerState(restored.timer!.endsAt, nowMs)).toBe("finished");
  });
});
