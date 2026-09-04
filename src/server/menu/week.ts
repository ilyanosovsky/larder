/**
 * The week vocabulary the whole menu feature agrees on (VISION §3.4).
 *
 * Pure, no drizzle, unit-tested — 5.1's `menu.current`/`addDish`, 5.2's
 * build and 5.3's history all read their week from here, so there is exactly
 * one calendar in the app rather than one per procedure.
 */

/**
 * The zone a week starts in.
 *
 * **A code constant, and its value is UTC.** MVP is one household
 * (VISION §5), so a second source of truth would be one more thing to keep in
 * step; an env var would mean the same stored week silently means a different
 * Monday after a deploy, plus three registration sites (AGENTS.md) for a
 * string only this module reads.
 *
 * UTC rather than a guess: nothing in this repo names a zone, and
 * `src/app/(app)/settings/trip-history-section.tsx` states in so many words
 * that no global `timeZone` is configured and that pinning the household's
 * own zone «is a settings question for task 7.1, not something to invent
 * here». The accepted cost is stated plainly: a household three hours east of
 * UTC sees the new week begin at 03:00 local on Monday rather than at
 * midnight. Nothing is lost — the menu they built on Sunday stays current a
 * few hours longer — and both partners always agree, which a client-computed
 * week could not guarantee.
 *
 * Every function below takes the zone as an argument, so task 7.1 turning
 * this into `households.time_zone` changes one constant and no call site's
 * logic.
 */
export const MENU_TIME_ZONE = "UTC";

/**
 * How many past weeks `menu.history` (task 5.3) reads. A flat list, no
 * cursor: a household lives one week a week, so 12 is a quarter of cooking
 * and the block is a collapsed list at the bottom of S10 rather than a
 * browsable archive. Same shape and same reasoning as `TRIP_HISTORY_LIMIT`;
 * this constant is the reminder that there is no cursor yet.
 */
export const WEEK_HISTORY_LIMIT = 12;

/** Titles carried on a collapsed history row before it says «+N» (task 5.3). */
export const WEEK_HISTORY_TITLES = 8;

/** Milliseconds in a day. Only ever added to a *civil* date, never to an instant. */
const DAY_MS = 86_400_000;

/**
 * «YYYY-MM-DD» as the given zone reads the instant.
 *
 * «en-CA» is the locale whose short date format *is* ISO 8601, which is why
 * it is used rather than assembling three `formatToParts` entries by hand.
 */
function civilDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * A civil «YYYY-MM-DD» read back as the UTC midnight of that day.
 *
 * Not a timestamp anybody stores — purely a handle for `getUTCDay()` and for
 * whole-day arithmetic. `Date.UTC` is what keeps DST out of it: the process's
 * own zone never enters the calculation, so a spring-forward Sunday inside
 * the week cannot shift the answer by an hour and a day cannot go missing.
 */
function utcMidnight(isoDate: string): Date {
  // The shape is checked rather than inferred from the destructuring: a
  // «2026-08» would otherwise read as a two-element split and a
  // «2026-08-04-99» would silently keep its first three parts.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`Not a YYYY-MM-DD date: ${isoDate}`);
  }

  const [year, month, day] = isoDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];

  const instant = new Date(Date.UTC(year, month - 1, day));

  // `Date.UTC` *rolls over* an impossible date rather than refusing it —
  // «2026-02-30» silently becomes 2 March — so the only way to tell a real
  // date from a rolled-over one is to format it back and compare. Left
  // unchecked, a wrong week label would look exactly like a right one.
  if (isoOf(instant) !== isoDate) {
    throw new Error(`Not a calendar date: ${isoDate}`);
  }

  return instant;
}

/** «YYYY-MM-DD» of a UTC-midnight handle. */
function isoOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Which week a moment belongs to, as a «YYYY-MM-DD» Monday.
 *
 * **Computed in TypeScript and bound as a parameter, never as
 * `date_trunc('week', now())` inside the statement.** Two reasons, both hard:
 * the router tests stub the database and pin *literal bound values*
 * (`src/server/api/test-support.ts` compiles clauses with `PgDialect`), which
 * an in-SQL expression makes impossible; and `date_trunc` over a
 * `timestamptz` truncates in the session's `TimeZone`, so the answer would
 * silently depend on a Postgres setting nothing in this repo sets.
 *
 * Monday-first, per the Russian convention DESIGN_BRIEF's own «4–10 августа»
 * uses. The civil date is *formatted* in `timeZone`, then rebuilt as a UTC
 * instant purely to ask `getUTCDay()` and shift whole days — so no duration is
 * ever measured and a DST boundary inside the week cannot move the answer.
 * Nothing here reads the process's `TZ`.
 *
 * **The server decides, not the client.** The alternative — the browser sends
 * its local Monday — was rejected for a reason specific to this product: the
 * menu and the cart are *shared*, so two partners in two zones would disagree
 * about which week is current and «Собрать корзину» would build two different
 * carts; and it would make `/menu` un-prefetchable, so the phase's main
 * screen would always paint a skeleton first.
 */
export function weekStartOf(
  instant: Date,
  timeZone: string = MENU_TIME_ZONE,
): string {
  const today = utcMidnight(civilDate(instant, timeZone));
  // `getUTCDay()` is 0 for Sunday, so Sunday is six days *after* its Monday —
  // the off-by-one that would otherwise empty the pool every Sunday evening.
  const sinceMonday = (today.getUTCDay() + 6) % 7;

  return isoOf(new Date(today.getTime() - sinceMonday * DAY_MS));
}

/** `isoDate` shifted by whole days, same «YYYY-MM-DD» shape. */
export function addDays(isoDate: string, days: number): string {
  return isoOf(new Date(utcMidnight(isoDate).getTime() + days * DAY_MS));
}

/** The Sunday that closes the week `weekStart` opens — «YYYY-MM-DD». */
export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}
