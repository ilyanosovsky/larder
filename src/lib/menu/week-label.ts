/**
 * «4–10 августа» · «28 июля – 3 августа» · «28 декабря 2026 г. – 3 января 2027 г.»
 *
 * `Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone:
 * "UTC" }).formatRange(from, to)` — which is what produces the genitive month
 * («августа», not the nominative «август» a bare month format gives) and
 * collapses a same-month range to one month name. Both are things a
 * hand-built string or a two-branch ICU message gets wrong, and both are in
 * DESIGN_BRIEF §5's own content.
 *
 * **A formatted date is data, not copy** — the same treatment
 * `formatRecipeQty` gives a unit — so this needs no next-intl message. The
 * words around it («Меню на неделю») still come from the dictionary.
 *
 * A raw `Intl` call rather than next-intl's `useFormatter` is a deliberate,
 * narrow exception to `trip-history-section.tsx`'s standing rule, and the
 * reason that rule exists is neutralised here: its hazard is a call whose zone
 * is the server's during SSR and the browser's after hydration, and **both**
 * the locale and `timeZone: "UTC"` are pinned. Pinning UTC is also mandatory
 * rather than cosmetic: the stored value is a calendar label parsed as UTC
 * midnight, and any other zone renders the previous day west of Greenwich.
 * Being a pure function is what makes it testable at all — vitest runs in a
 * node environment with no DOM, so a hook could not be.
 */
const WEEK_RANGE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/**
 * The shape check `Date.parse` will not make: `new Date("2026-08T00:00…")`
 * is a *valid* ISO instant meaning the 1st of the month, so a truncated
 * label would render a confidently wrong day instead of failing.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A «YYYY-MM-DD» calendar label as the UTC midnight the formatter reads. */
function utcMidnight(isoDate: string): Date {
  const parsed = ISO_DATE.test(isoDate)
    ? new Date(`${isoDate}T00:00:00.000Z`)
    : new Date(Number.NaN);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Not a YYYY-MM-DD date: ${isoDate}`);
  }

  // `Date.parse` rolls an impossible date over instead of refusing it —
  // «2026-02-30» parses as 2 March — and a week label formatted from the
  // wrong day looks exactly like one formatted from the right day. The
  // round-trip is the only thing that separates them.
  if (parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new Error(`Not a calendar date: ${isoDate}`);
  }

  return parsed;
}

/**
 * S10's header line: the week `weekStart` opens and `weekEnd` closes, both
 * «YYYY-MM-DD» as `src/server/menu/week.ts` produces them.
 */
export function formatWeekRange(weekStart: string, weekEnd: string): string {
  return WEEK_RANGE_FORMAT.formatRange(
    utcMidnight(weekStart),
    utcMidnight(weekEnd),
  );
}

/**
 * Whether a «Корзина собрана» stamp belongs to the week on screen.
 *
 * S10's quiet line exists so the second partner does not rebuild out of
 * habit; a stamp from *last* week says the opposite of what it looks like, so
 * the line has to be gated rather than merely rendered when non-null.
 *
 * The comparison is instant-against-instant: `weekStart` is a calendar label,
 * and the moment it opens is its UTC midnight — the same reading
 * `weekStartOf` produced it under. A string comparison against a formatted
 * `lastBuiltAt` would be the same answer computed twice, in two zones.
 *
 * Here rather than inline in the screen for the reason every branch in this
 * app is: vitest runs in `node` with no DOM, so a ternary in a `.tsx` is
 * unreachable from the suite.
 */
export function isBuiltInWeek(
  lastBuiltAt: Date | null,
  weekStart: string,
): boolean {
  if (lastBuiltAt === null) {
    return false;
  }

  return lastBuiltAt.getTime() >= utcMidnight(weekStart).getTime();
}
