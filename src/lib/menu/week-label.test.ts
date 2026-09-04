import { afterEach, describe, expect, it } from "vitest";

import { weekEndOf, weekStartOf } from "@/server/menu/week";

import { formatWeekRange, isBuiltInWeek } from "./week-label";

describe("formatWeekRange", () => {
  it("renders DESIGN_BRIEF's own week label, month named once", () => {
    // «4–10 августа», verbatim from DESIGN_BRIEF S10 — the genitive month a
    // bare `month: "long"` would give as «август», and one month name rather
    // than two because both ends sit in it.
    expect(formatWeekRange("2026-08-04", "2026-08-10")).toBe("4–10 августа");
  });

  it("names both months when the week straddles them", () => {
    // «28 июля – 3 августа», verbatim from DESIGN_BRIEF §5's «Прошлые недели».
    expect(formatWeekRange("2026-07-28", "2026-08-03")).toBe(
      "28 июля – 3 августа",
    );
  });

  it("adds the year on both ends when the week straddles one", () => {
    // CLDR separates the year from «г.» with U+202F (narrow no-break space),
    // spelled out here rather than pasted so a future reader does not "fix"
    // it into an ordinary space and get a green test with a wrong string.
    expect(formatWeekRange("2026-12-28", "2027-01-03")).toBe(
      "28 декабря 2026 г. – 3 января 2027 г.",
    );
  });

  it("reads the week module's own output", () => {
    const start = weekStartOf(new Date("2026-08-06T12:00:00.000Z"));

    expect(formatWeekRange(start, weekEndOf(start))).toBe("3–9 августа");
  });

  it("refuses a value that is not a date", () => {
    expect(() => formatWeekRange("2026-08", "2026-08-10")).toThrow();
  });

  it("refuses a well-shaped date that is not on the calendar", () => {
    // `Date.parse` rolls «2026-02-30» over to 2 March, and a label formatted
    // from the wrong day looks exactly like one formatted from the right day.
    expect(() => formatWeekRange("2026-02-30", "2026-03-08")).toThrow();
    expect(() => formatWeekRange("2026-02-23", "2026-02-31")).toThrow();
    expect(() => formatWeekRange("2026-13-01", "2026-13-07")).toThrow();
  });

  describe("independence from the process's own zone", () => {
    const original = process.env.TZ;

    afterEach(() => {
      process.env.TZ = original;
    });

    it("renders the same day west of Greenwich", () => {
      // The stored value is a calendar label parsed as UTC midnight, so a
      // formatter without `timeZone: "UTC"` would render «3–9 августа» in
      // America/New_York — the previous day, on both ends.
      process.env.TZ = "America/New_York";

      expect(formatWeekRange("2026-08-04", "2026-08-10")).toBe("4–10 августа");
    });
  });
});

describe("isBuiltInWeek", () => {
  it("is false while nothing has been built", () => {
    expect(isBuiltInWeek(null, "2026-08-03")).toBe(false);
  });

  it("accepts the very first instant of the week", () => {
    // Midnight on the Monday in `MENU_TIME_ZONE` — 20:00 UTC on the Sunday,
    // because the household is at UTC+4.
    expect(
      isBuiltInWeek(new Date("2026-08-02T20:00:00.000Z"), "2026-08-03"),
    ).toBe(true);
  });

  it("accepts a stamp from inside the week", () => {
    expect(
      isBuiltInWeek(new Date("2026-08-06T18:00:00.000Z"), "2026-08-03"),
    ).toBe(true);
  });

  it("accepts the four hours UTC would have thrown away", () => {
    // The zone bug this gate had while `MENU_TIME_ZONE` was UTC: a cart built
    // at 01:00 on Monday in Batumi is 21:00 UTC on the Sunday, so a UTC
    // midnight boundary called it last week's and hid the line for the four
    // hours it is most likely to be true. `weekStartOf` buckets that same
    // instant into this week, so the two must agree.
    const mondayOneAm = new Date("2026-08-02T21:00:00.000Z");

    expect(weekStartOf(mondayOneAm)).toBe("2026-08-03");
    expect(isBuiltInWeek(mondayOneAm, "2026-08-03")).toBe(true);
  });

  it("rejects last week's stamp", () => {
    // The whole reason the line is gated: «Корзина собрана · 28 июля» over
    // this week's pool says the opposite of what it looks like. 19:59:59 UTC
    // on the Sunday is 23:59:59 local — the last second of the week before.
    expect(
      isBuiltInWeek(new Date("2026-08-02T19:59:59.999Z"), "2026-08-03"),
    ).toBe(false);
  });
});
