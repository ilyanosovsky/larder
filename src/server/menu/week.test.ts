import { afterEach, describe, expect, it } from "vitest";

import {
  addDays,
  MENU_TIME_ZONE,
  weekEndOf,
  weekStartOf,
  WEEK_HISTORY_LIMIT,
  WEEK_HISTORY_TITLES,
} from "./week";

describe("MENU_TIME_ZONE", () => {
  it("is UTC — the shipped value task 7.1 replaces with the household's own", () => {
    expect(MENU_TIME_ZONE).toBe("UTC");
  });
});

describe("weekStartOf", () => {
  it("maps every day of one week to the same Monday", () => {
    // 2026-08-03 is a Monday; DESIGN_BRIEF S10's own «4–10 августа» sits in
    // the week after it.
    const days = [
      "2026-08-03T00:00:00.000Z",
      "2026-08-03T23:59:59.999Z",
      "2026-08-04T12:00:00.000Z",
      "2026-08-05T12:00:00.000Z",
      "2026-08-06T12:00:00.000Z",
      "2026-08-07T12:00:00.000Z",
      "2026-08-08T12:00:00.000Z",
      "2026-08-09T23:00:00.000Z",
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
      const inUtc = weekStartOf(instant);

      process.env.TZ = "America/New_York";
      const inNewYork = weekStartOf(instant);

      process.env.TZ = "Asia/Tokyo";
      const inTokyo = weekStartOf(instant);

      expect(inUtc).toBe("2026-08-10");
      expect(inNewYork).toBe(inUtc);
      expect(inTokyo).toBe(inUtc);
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
