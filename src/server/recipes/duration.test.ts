import { describe, expect, it } from "vitest";

import {
  parseDurationMin,
  parseIsoDuration,
  parseRussianDuration,
} from "./duration";

describe("parseIsoDuration", () => {
  it.each([
    ["PT1H15M", 75],
    ["PT30M", 30],
    ["PT20M", 20],
    ["PT2H", 120],
    ["P1DT2H", 1560],
    ["PT90S", 2],
    ["pt45m", 45],
  ])("reads %s as %i minutes", (raw, minutes) => {
    expect(parseIsoDuration(raw)).toBe(minutes);
  });

  it("reads a zero duration as «not stated», not as zero", () => {
    // eda.rambler.ru emits `PT0M` for `prepTime` on most recipes. Storing a 0
    // would make S7 render «0 мин» as though somebody had measured it.
    expect(parseIsoDuration("P0D")).toBeNull();
    expect(parseIsoDuration("PT0M")).toBeNull();
    expect(parseIsoDuration("PT0S")).toBeNull();
  });

  it.each(["", "  ", "30 минут", "P", "PT", "garbage", "1H15M"])(
    "returns null for %o",
    (raw) => {
      expect(parseIsoDuration(raw)).toBeNull();
    },
  );

  it("returns null for null", () => {
    expect(parseIsoDuration(null)).toBeNull();
  });
});

describe("parseRussianDuration", () => {
  it.each([
    ["1 ч 20 мин", 80],
    ["1ч20мин", 80],
    ["30 минут", 30],
    ["45 мин.", 45],
    ["2 часа", 120],
    ["1 час", 60],
    ["3 ч", 180],
    ["Время приготовления: 25 минут", 25],
  ])("reads «%s» as %i minutes", (raw, minutes) => {
    expect(parseRussianDuration(raw)).toBe(minutes);
  });

  it("puts the hours before the minutes, not the other way round", () => {
    // Reading «1 ч 20 мин» left to right with one pattern gives 1.
    expect(parseRussianDuration("1 ч 20 мин")).toBe(80);
    expect(parseRussianDuration("20 мин 1 ч")).toBe(80);
  });

  it.each(["полтора часа", "недолго", "", "быстро"])(
    "returns null for «%s» — a word is not a number",
    (raw) => {
      expect(parseRussianDuration(raw)).toBeNull();
    },
  );
});

describe("parseDurationMin", () => {
  it("tries ISO first and Russian prose second", () => {
    expect(parseDurationMin("PT1H15M")).toBe(75);
    expect(parseDurationMin("1 ч 20 мин")).toBe(80);
    expect(parseDurationMin("что-то")).toBeNull();
    expect(parseDurationMin(null)).toBeNull();
  });

  it("reads a hostile digit run in milliseconds instead of minutes of CPU", () => {
    // The page controls this string — `totalTime` inside a 500 KB ld+json
    // block, or the text of any `itemprop` on a 2 MB page. Both Russian
    // patterns are global and alternating, so before the length cap a run of
    // digits backtracked quadratically: 128 000 digits measured at 51 seconds
    // of *synchronous* CPU, which no `AbortSignal` can interrupt — it burns
    // the whole `maxDuration` and returns a 504 with no `jobId`.
    const started = Date.now();

    expect(parseDurationMin("9".repeat(128_000))).toBeNull();
    expect(parseDurationMin(`${"9".repeat(128_000)} минут`)).toBeNull();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still reads a real duration that happens to be padded", () => {
    // The cap must not eat the answer: 200 characters is far past any real
    // `totalTime`, and the value is at the front of the string.
    expect(parseDurationMin(`PT1H15M${" ".repeat(400)}`)).toBe(75);
    expect(parseDurationMin(`Время: 30 мин${"!".repeat(400)}`)).toBe(30);
  });
});

describe("the upper bound", () => {
  it("refuses a duration no kitchen could mean", () => {
    // 100 000 minutes is ten weeks. `draftFromParsed` caps again at 6 000 on
    // the way into a draft, but the hint the model reads comes from here.
    expect(parseIsoDuration("PT9999H")).toBeNull();
    expect(parseRussianDuration("100000 часов")).toBeNull();
    expect(parseDurationMin("2000 часов")).toBeNull();
  });

  it("keeps a long-but-possible one", () => {
    // A two-day brine is a real recipe; the schema is what refuses to store
    // it, not the reader that reports what the page said.
    expect(parseIsoDuration("PT48H")).toBe(2_880);
    expect(parseRussianDuration("36 часов")).toBe(2_160);
  });

  it("refuses a seven-digit duration whichever guard catches it first", () => {
    // Two guards agree here, deliberately: the numeric groups are written
    // `\d{1,6}` rather than `\d+` (six digits is already past the cap, so
    // bounding them loses no readable input while stopping any single
    // position from backtracking far), and `usableMinutes` refuses the value
    // anyway. The group bound is defence for a future caller that skips
    // `parseDurationMin`'s length cap; this pins the outcome either way.
    expect(parseRussianDuration("1234567 минут")).toBeNull();
    expect(parseIsoDuration("PT1234567M")).toBeNull();
  });
});
