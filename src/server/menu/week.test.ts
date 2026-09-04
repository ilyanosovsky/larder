import { afterEach, describe, expect, it } from "vitest";

import {
  addDays,
  MENU_TIME_ZONE,
  weekEndOf,
  weekStartInstant,
  weekStartOf,
  WEEK_HISTORY_LIMIT,
  WEEK_HISTORY_TITLES,
} from "./week";

describe("MENU_TIME_ZONE", () => {
  it("is the household's own zone — the value task 7.1 moves into a column", () => {
    // Batumi (2026-09-04). Pinned as a literal rather than derived, because
    // the whole point of the constant is that it does not drift: a silent
    // change here re-buckets every stored week's boundary.
    expect(MENU_TIME_ZONE).toBe("Asia/Tbilisi");
  });

  it("is a zone Intl knows, and one that is UTC+4 with no DST", () => {
    // Georgia dropped DST in 2005, which is why the constant needs no
    // seasonal caveat anywhere. Read in January and in July.
    for (const instant of ["2026-01-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"]) {
      const opens = weekStartInstant(
        weekStartOf(new Date(instant)),
        MENU_TIME_ZONE,
      );
      // Midnight Monday in UTC+4 is 20:00 UTC on the Sunday.
      expect(opens.toISOString()).toMatch(/T20:00:00\.000Z$/);
    }
  });
});

describe("weekStartOf", () => {
  it("maps every day of one week to the same Monday", () => {
    // 2026-08-03 is a Monday; DESIGN_BRIEF S10's own «4–10 августа» sits in
    // the week after it. Written as UTC instants, read in `MENU_TIME_ZONE`
    // (UTC+4), so the first entry is 04:00 Monday local and the last is
    // 23:59 Sunday local — the two ends of one Batumi week.
    const days = [
      "2026-08-02T20:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      "2026-08-04T12:00:00.000Z",
      "2026-08-05T12:00:00.000Z",
      "2026-08-06T12:00:00.000Z",
      "2026-08-07T12:00:00.000Z",
      "2026-08-08T12:00:00.000Z",
      "2026-08-09T19:59:59.999Z",
    ];

    for (const day of days) {
      expect(weekStartOf(new Date(day))).toBe("2026-08-03");
    }
  });

  it("puts Sunday in the week that is ending, not the one about to start", () => {
    // The off-by-one `getUTCDay() === 0` invites, and the reason D3's Sunday
    // rollover was rejected: a pool that emptied at Sunday lunchtime would
    // empty the one screen whose job is that pool.
    expect(weekStartOf(new Date("2026-08-09T12:00:00.000Z"))).toBe(
      "2026-08-03",
    );
    expect(weekStartOf(new Date("2026-08-10T00:00:00.000Z"))).toBe(
      "2026-08-10",
    );
  });

  it("turns the week over at midnight in MENU_TIME_ZONE, not at midnight UTC", () => {
    // The regression the zone change exists to prevent, at its own boundary:
    // 19:59 and 20:00 UTC on the Sunday are 23:59 Sunday and 00:00 Monday in
    // Batumi, so they are different weeks — while UTC would have kept both in
    // the week that is ending and only rolled over at 04:00 local.
    expect(weekStartOf(new Date("2026-08-09T19:59:59.999Z"))).toBe(
      "2026-08-03",
    );
    expect(weekStartOf(new Date("2026-08-09T20:00:00.000Z"))).toBe(
      "2026-08-10",
    );
  });

  it("returns a bare YYYY-MM-DD with no time and no offset", () => {
    const value = weekStartOf(new Date("2026-08-06T18:42:07.123Z"));

    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("crosses a month boundary", () => {
    // 2026-08-31 is itself a Monday, so the week it opens runs into September.
    expect(weekStartOf(new Date("2026-09-02T12:00:00.000Z"))).toBe(
      "2026-08-31",
    );
  });

  it("crosses a year boundary", () => {
    // 2027-01-01 is a Friday — its week opened on 2026-12-28.
    expect(weekStartOf(new Date("2027-01-01T12:00:00.000Z"))).toBe(
      "2026-12-28",
    );
  });

  it("crosses a leap day", () => {
    // 2028-02-29 is a Tuesday; its Monday is the last day of February's
    // predecessor month.
    expect(weekStartOf(new Date("2028-02-29T12:00:00.000Z"))).toBe(
      "2028-02-28",
    );
  });

  it("puts Sunday 23:30 and Monday 00:30 of the given zone in different weeks", () => {
    // The boundary is the *zone's* midnight, not the instant's. In
    // Europe/Madrid (UTC+2 in August) these two instants are 23:30 Sunday and
    // 00:30 Monday local, so they must land in different weeks even though
    // they are 20:30 and 21:30 UTC on the same day.
    const sundayLate = new Date("2026-08-09T21:30:00.000Z");
    const mondayEarly = new Date("2026-08-09T22:30:00.000Z");

    expect(weekStartOf(sundayLate, "Europe/Madrid")).toBe("2026-08-03");
    expect(weekStartOf(mondayEarly, "Europe/Madrid")).toBe("2026-08-10");
  });

  it("is unmoved by a spring-forward Sunday inside the week", () => {
    // Europe/Madrid springs forward on 2026-03-29 (a Sunday). A naive
    // `- 86400e3 * n` walk from a *local* midnight would land 23 hours back
    // and report the previous Sunday as the Monday.
    expect(weekStartOf(new Date("2026-03-29T12:00:00.000Z"), "Europe/Madrid")).toBe(
      "2026-03-23",
    );
    expect(weekStartOf(new Date("2026-03-30T12:00:00.000Z"), "Europe/Madrid")).toBe(
      "2026-03-30",
    );
  });

  it("is unmoved by a fall-back Sunday inside the week", () => {
    // Europe/Madrid falls back on 2026-10-25 (a Sunday) — the mirror image,
    // where the naive walk overshoots by an hour.
    expect(weekStartOf(new Date("2026-10-25T12:00:00.000Z"), "Europe/Madrid")).toBe(
      "2026-10-19",
    );
    expect(weekStartOf(new Date("2026-10-26T12:00:00.000Z"), "Europe/Madrid")).toBe(
      "2026-10-26",
    );
  });

  describe("independence from the process's own zone", () => {
    const original = process.env.TZ;

    afterEach(() => {
      process.env.TZ = original;
    });

    it("answers the same in a non-UTC process", () => {
      // The regression this catches is a `new Date(y, m, d)` or a
      // `toLocaleDateString()` with no `timeZone` slipping into the module:
      // west of Greenwich either one reports the previous day, so a Monday
      // 00:30 UTC would be bucketed into the week before.
      const instant = new Date("2026-08-10T00:30:00.000Z");

      process.env.TZ = "UTC";
      const underUtc = weekStartOf(instant);

      process.env.TZ = "America/New_York";
      const underNewYork = weekStartOf(instant);

      process.env.TZ = "Asia/Tokyo";
      const underTokyo = weekStartOf(instant);

      // 04:30 on the Monday in `MENU_TIME_ZONE` — the same answer whatever
      // the process thinks its own zone is.
      expect(underUtc).toBe("2026-08-10");
      expect(underNewYork).toBe(underUtc);
      expect(underTokyo).toBe(underUtc);
    });
  });
});

describe("weekEndOf", () => {
  it("is always six days after the Monday, and always a Sunday", () => {
    const mondays = [
      new Date("2026-08-04T12:00:00.000Z"),
      new Date("2026-12-31T12:00:00.000Z"),
      new Date("2028-02-29T12:00:00.000Z"),
      new Date("2026-03-29T12:00:00.000Z"),
    ];

    for (const instant of mondays) {
      const start = weekStartOf(instant);
      const end = weekEndOf(start);

      expect(addDays(start, 6)).toBe(end);
      // Read back as UTC midnight (which is how the label formatter parses
      // it too) the closing day is a Sunday.
      expect(new Date(`${end}T00:00:00.000Z`).getUTCDay()).toBe(0);
    }
  });
});

describe("weekStartInstant", () => {
  it("opens the Batumi week at 20:00 UTC on the Sunday", () => {
    // UTC+4: the moment «this week» begins for the household is four hours
    // before UTC would have said so, and `isBuiltInWeek` compares against
    // exactly this instant.
    expect(weekStartInstant("2026-08-03").toISOString()).toBe(
      "2026-08-02T20:00:00.000Z",
    );
  });

  it("agrees with weekStartOf on both sides of its own boundary", () => {
    const opens = weekStartInstant("2026-08-03").getTime();

    expect(weekStartOf(new Date(opens))).toBe("2026-08-03");
    expect(weekStartOf(new Date(opens - 1))).toBe("2026-07-27");
    expect(weekStartOf(new Date(opens + 7 * 86_400_000 - 1))).toBe("2026-08-03");
  });

  it("reads the offset that was actually in force, DST and all", () => {
    // Europe/Madrid is UTC+1 in March and UTC+2 from the 29th, so two
    // consecutive weeks open at different UTC times. What this pins is that
    // the offset comes from `Intl` at the instant in question rather than
    // from a constant: any hard-coded offset gets one of the two wrong by an
    // hour. Madrid's own transition is at 01:00 UTC on the Sunday, far from
    // the Monday-midnight guess, so both passes agree here — the case that
    // separates them is below.
    expect(weekStartInstant("2026-03-23", "Europe/Madrid").toISOString()).toBe(
      "2026-03-22T23:00:00.000Z",
    );
    expect(weekStartInstant("2026-03-30", "Europe/Madrid").toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
  });

  it("re-reads the offset at the corrected instant, not at the naive guess", () => {
    // Why there are two passes at all. Iran moved its clocks forward at
    // 00:00 local on 22 March 2021 — exactly the midnight this function is
    // looking for — so the offset read at the naive UTC-midnight guess
    // (+03:30, still winter time there) is not the one in force at the
    // instant that guess corrects to (+04:30). One pass answers 19:30 UTC,
    // which `weekStartOf` then buckets under the *previous* Monday.
    //
    // `Asia/Tbilisi` has had no DST since 2005, so this is a guard on the
    // constant task 7.1 turns into `households.time_zone`, not on today's
    // behaviour. (It does rely on the host ICU carrying Iran's pre-2022
    // rules; the invariant below is the version that needs no tzdata luck.)
    expect(weekStartInstant("2021-03-22", "Asia/Tehran").toISOString()).toBe(
      "2021-03-21T20:30:00.000Z",
    );
  });

  it("round-trips through weekStartOf in every zone shape", () => {
    // The invariant the second pass exists to preserve: the instant a week
    // opens must be bucketed back into that same week. A half-hour zone, a
    // DST zone on both of its transition weeks, a zone that transitions at
    // local midnight, and the household's own.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["2026-08-03", "Asia/Tbilisi"],
      ["2026-08-03", "Asia/Kolkata"],
      ["2026-03-23", "Europe/Madrid"],
      ["2026-03-30", "Europe/Madrid"],
      ["2026-10-26", "Europe/Madrid"],
      ["2021-03-22", "Asia/Tehran"],
      ["2026-01-05", "America/Los_Angeles"],
    ];

    for (const [weekStart, timeZone] of cases) {
      const opens = weekStartInstant(weekStart, timeZone);

      expect(weekStartOf(opens, timeZone)).toBe(weekStart);
      // And the millisecond before it belongs to the week before — which is
      // what makes the line above a boundary rather than a coincidence.
      expect(weekStartOf(new Date(opens.getTime() - 1), timeZone)).toBe(
        addDays(weekStart, -7),
      );
    }
  });

  it("refuses anything that is not a real calendar date", () => {
    expect(() => weekStartInstant("2026-08")).toThrow();
    expect(() => weekStartInstant("2026-02-30")).toThrow();
  });
});

describe("addDays", () => {
  it("shifts whole days forwards and backwards across month and year ends", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2027-01-04", -7)).toBe("2026-12-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("refuses anything that is not a bare YYYY-MM-DD", () => {
    // Not just gibberish: «2026-08» reads as a valid ISO instant to
    // `Date.parse` (the 1st of the month), so a truncated label would
    // silently shift a whole week rather than fail.
    expect(() => addDays("not-a-date", 1)).toThrow();
    expect(() => addDays("2026-08", 1)).toThrow();
    expect(() => addDays("2026-08-04T00:00:00.000Z", 1)).toThrow();
  });

  it("refuses a well-shaped date that is not on the calendar", () => {
    // `Date.UTC` rolls these over instead of refusing them — «2026-02-30» is
    // 2 March — so a wrong week would be indistinguishable from a right one.
    expect(() => addDays("2026-02-30", 1)).toThrow();
    expect(() => addDays("2026-13-01", 1)).toThrow();
    expect(() => addDays("2026-00-10", 1)).toThrow();
    expect(() => addDays("2026-04-31", 1)).toThrow();
    // 2026 is not a leap year; 2028 is.
    expect(() => addDays("2026-02-29", 1)).toThrow();
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("the history constants", () => {
  it("keep 5.3's collapsed block a quarter of cooking, not an archive", () => {
    expect(WEEK_HISTORY_LIMIT).toBe(12);
    expect(WEEK_HISTORY_TITLES).toBe(8);
  });
});
