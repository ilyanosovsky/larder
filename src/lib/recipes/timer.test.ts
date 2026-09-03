import { describe, expect, it } from "vitest";

import {
  formatTimerClock,
  startTimer,
  timerDisplay,
  timerRemainingMs,
  timerState,
} from "./timer";

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

// ── The countdown (task 4.7): `endsAt`-anchored, never an accumulated
// interval. Every assertion below re-derives "how much is left" from a
// fixed `nowMs`, the same thing `cooking-overlay.tsx`'s 250ms tick does —
// there is nothing here that could drift if the tick itself were delayed. ──

describe("startTimer / timerRemainingMs / timerState", () => {
  it("anchors on the lower bound, in ms, from the given now", () => {
    expect(startTimer(1_000, 540)).toEqual({ endsAt: 1_000 + 540_000 });
  });

  it("clamps a non-positive duration to an immediately-finished timer", () => {
    expect(startTimer(1_000, 0)).toEqual({ endsAt: 1_000 });
    expect(startTimer(1_000, -30)).toEqual({ endsAt: 1_000 });
  });

  it("remaining time is monotone non-increasing as now advances", () => {
    const { endsAt } = startTimer(0, 60);
    const samples = [0, 100, 15_000, 30_000, 45_000, 59_999, 60_000, 90_000];
    const remaining = samples.map((now) => timerRemainingMs(endsAt, now));

    for (let i = 1; i < remaining.length; i++) {
      expect(remaining[i]).toBeLessThanOrEqual(remaining[i - 1] as number);
    }
  });

  it("is never negative, however far past `endsAt` `now` is", () => {
    const { endsAt } = startTimer(0, 10);
    expect(timerRemainingMs(endsAt, 10_000)).toBe(0);
    expect(timerRemainingMs(endsAt, 999_999)).toBe(0);
  });

  it("reads «running» while time remains and «finished» at exactly zero", () => {
    const { endsAt } = startTimer(0, 10);
    expect(timerState(endsAt, 9_999)).toBe("running");
    expect(timerState(endsAt, 10_000)).toBe("finished");
  });

  it("a restored `endsAt` already in the past is «finished», never a negative clock", () => {
    // The tab was closed mid-timer and reopened long after it would have
    // rung — the honest answer is «готово», not a countdown running
    // backwards through negative numbers.
    const pastEndsAt = startTimer(0, 60).endsAt;
    const reopenedMuchLater = 10 * 60_000;

    expect(timerState(pastEndsAt, reopenedMuchLater)).toBe("finished");
    expect(timerRemainingMs(pastEndsAt, reopenedMuchLater)).toBe(0);
  });

  it("survives a simulated 60s background gap with a true countdown, not an accumulated-interval drift", () => {
    // The scenario `endsAt`-anchoring exists for: a 9-minute timer starts,
    // the tab is backgrounded (mobile browsers throttle/suspend timers
    // there), and 60 real seconds pass with *zero* ticks actually firing.
    // The very next tick, whenever it does fire, must still report exactly
    // 60s less than before — not "however many ticks happened to fire".
    const t0 = 1_000_000;
    const { endsAt } = startTimer(t0, 9 * 60);

    const beforeBackground = timerRemainingMs(endsAt, t0 + 500);
    const afterBackgroundGap = timerRemainingMs(endsAt, t0 + 500 + 60_000);

    expect(beforeBackground - afterBackgroundGap).toBe(60_000);
    expect(timerState(endsAt, t0 + 500 + 60_000)).toBe("running");
  });
});

describe("formatTimerClock", () => {
  it("renders minutes:seconds under an hour, zero-padded", () => {
    expect(formatTimerClock(9 * 60_000)).toBe("09:00");
    expect(formatTimerClock(0)).toBe("00:00");
    expect(formatTimerClock(5_000)).toBe("00:05");
  });

  it("renders hours:minutes:seconds at and above an hour", () => {
    expect(formatTimerClock(60 * 60_000)).toBe("01:00:00");
    expect(formatTimerClock(60 * 60_000 + 90_000)).toBe("01:01:30");
  });

  it("never renders negative — a caller passing raw `endsAt - now` clamps at zero", () => {
    expect(formatTimerClock(-5_000)).toBe("00:00");
  });

  it("rounds up so the very first tick still reads the full value", () => {
    // 9:00 minus 1ms must still read «09:00», not drop to «08:59» the
    // instant the timer starts.
    expect(formatTimerClock(9 * 60_000 - 1)).toBe("09:00");
  });
});
