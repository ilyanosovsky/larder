import { afterEach, describe, expect, it } from "vitest";

import { weekEndOf, weekStartOf } from "@/server/menu/week";

import { formatWeekRange } from "./week-label";

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
