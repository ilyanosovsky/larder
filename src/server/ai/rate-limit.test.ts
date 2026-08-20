import { describe, expect, it } from "vitest";

import {
  AI_LIMIT_PER_DAY,
  AI_LIMIT_PER_MINUTE,
  checkRateLimit,
  DAY_WINDOW_MS,
  MINUTE_WINDOW_MS,
  rateLimitWindows,
} from "@/server/ai/rate-limit";

describe("checkRateLimit — the per-minute window", () => {
  it("allows the tenth call of the minute", () => {
    // Nine already made means this one is the tenth, and ten per minute is
    // the limit — so it goes through.
    expect(
      checkRateLimit({
        recentMinuteCount: AI_LIMIT_PER_MINUTE - 1,
        recentDayCount: 0,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses the eleventh", () => {
    expect(
      checkRateLimit({
        recentMinuteCount: AI_LIMIT_PER_MINUTE,
        recentDayCount: 0,
      }),
    ).toEqual({ allowed: false, reason: "minute" });
  });

  it("allows a first call", () => {
    expect(checkRateLimit({ recentMinuteCount: 0, recentDayCount: 0 })).toEqual(
      { allowed: true },
    );
  });
});

describe("checkRateLimit — the per-day window", () => {
  it("allows the hundredth call of the day", () => {
    expect(
      checkRateLimit({
        recentMinuteCount: 0,
        recentDayCount: AI_LIMIT_PER_DAY - 1,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses the hundred-and-first", () => {
    expect(
      checkRateLimit({
        recentMinuteCount: 0,
        recentDayCount: AI_LIMIT_PER_DAY,
      }),
    ).toEqual({ allowed: false, reason: "day" });
  });
});

describe("checkRateLimit — which window is reported", () => {
  it("reports the minute when both are exhausted", () => {
    // "Подожди минуту" is actionable; "лимит на сегодня" is not, so the
    // recoverable window is the one worth naming.
    expect(
      checkRateLimit({
        recentMinuteCount: AI_LIMIT_PER_MINUTE,
        recentDayCount: AI_LIMIT_PER_DAY,
      }),
    ).toEqual({ allowed: false, reason: "minute" });
  });

  it("refuses on the day window even when the minute is quiet", () => {
    expect(
      checkRateLimit({
        recentMinuteCount: 0,
        recentDayCount: AI_LIMIT_PER_DAY + 500,
      }),
    ).toEqual({ allowed: false, reason: "day" });
  });
});

describe("rateLimitWindows", () => {
  it("slides both windows back from the given instant", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");

    expect(rateLimitWindows(now)).toEqual({
      minuteStart: new Date(now.getTime() - MINUTE_WINDOW_MS),
      dayStart: new Date(now.getTime() - DAY_WINDOW_MS),
    });
  });

  it("slides rather than snapping to a calendar boundary", () => {
    // Calendar buckets would hand a fresh allowance to anyone who waits for
    // the top of the minute.
    const now = new Date("2026-08-20T12:00:30.000Z");

    expect(rateLimitWindows(now).minuteStart.toISOString()).toBe(
      "2026-08-20T11:59:30.000Z",
    );
  });
});
