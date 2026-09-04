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
 * **A code constant, and its value is the household's own zone.** MVP is one
 * household (VISION §5) and it lives in Batumi, so the week turns over at
 * midnight where the people planning it are — not at 04:00 local, which is
 * what UTC would have meant here. `Asia/Tbilisi` is UTC+4 all year (Georgia
 * dropped DST in 2005), so the boundary never moves; the functions below
 * still handle a DST zone correctly, because task 7.1 may put any zone here.
 *
 * A constant rather than an env var: an env var would mean the same stored
 * week silently names a different Monday after a deploy, plus three
 * registration sites (AGENTS.md) for a string only this module reads. And a
 * constant rather than the browser's zone: the menu and the cart are shared,
 * so two partners must never disagree about which week is current
 * (`weekStartOf`'s own comment).
 *
 * `src/app/(app)/settings/trip-history-section.tsx` still stands: a
 * `households.time_zone` column, and a UI for it, is task 7.1's. This is the
 * value that column will be seeded with, not a guess standing in for it.
 *
 * Every function below takes the zone as an argument, so task 7.1 turning
 * this into `households.time_zone` changes one constant and no call site's
 * logic.
 */
export const MENU_TIME_ZONE = "Asia/Tbilisi";

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

/**
 * How far `timeZone` was ahead of UTC at `instant`, in milliseconds.
 *
 * The wall clock the zone showed, read back as if it were UTC, minus the
 * instant itself — the one way to get an offset out of `Intl` without a
 * tz database of our own. `hourCycle: "h23"` because some ICU builds render
 * midnight as «24» under a bare `hour12: false`, which would put the offset a
 * day out.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const wallClock = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );

  return wallClock - instant.getTime();
}

/**
 * **The instant the week opens** — midnight of its Monday, in `timeZone`.
 *
 * `weekStart` is a calendar label, and every comparison against a stored
 * *instant* (`week_menus.last_built_at`, and 5.3's history cut) has to know
 * which midnight it means. Reading it as UTC midnight is wrong by exactly the
 * zone's offset: in `Asia/Tbilisi` the week opens at 20:00 UTC on the Sunday,
 * so a cart built at 01:00 Monday local would otherwise be reported as last
 * week's.
 *
 * Two passes over the offset, because the first one is read at a guess that
 * may sit on the wrong side of a DST change happening that very night; the
 * second reads it at the corrected instant. `Asia/Tbilisi` has had no DST
 * since 2005, so today the second pass is a no-op — it is here because task
 * 7.1 may put any zone in the constant above.
 */
export function weekStartInstant(
  weekStart: string,
  timeZone: string = MENU_TIME_ZONE,
): Date {
  // Also the shape/calendar check: `utcMidnight` refuses «2026-02-30».
  const naive = utcMidnight(weekStart).getTime();
  const firstPass = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));

  return new Date(naive - zoneOffsetMs(firstPass, timeZone));
}
