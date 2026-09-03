/**
 * Durations as a page states them, in minutes (blueprint §5).
 *
 * Two forms, because real pages use both: `totalTime` in schema.org markup is
 * an ISO-8601 duration (`PT1H15M`), while the same value in a microdata page's
 * visible text — and in half the JSON-LD written by hand — is Russian prose
 * («1 ч 20 мин»). `parseDurationMin` tries them in that order.
 *
 * The rule everywhere below is the one the whole import follows: **a value we
 * cannot read becomes `null`, never a plausible number.** `null` reaches the
 * review screen as an empty «Время» field the person can fill in; a guessed
 * 30 looks read and is not.
 *
 * Pure, no dependencies.
 */

/** Anything past this is not a cooking time. Mirrors `MAX_TOTAL_TIME_MIN`. */
const MAX_MINUTES = 100_000;

/**
 * `PT1H15M` → 75. `P1DT2H` → 1560. `P0D` → `null`.
 *
 * Zero is `null`, not `0`: a page that says `PT0M` (rambler emits exactly
 * that for `prepTime`) is saying «not stated», and storing a zero would make
 * S7 render «0 мин» as though somebody had measured it.
 *
 * Only whole minutes survive — seconds are read so `PT90S` is not lost, but
 * they are rounded rather than stored, because `recipes.total_time_min` is an
 * integer count of minutes and a recipe timed to the second does not exist.
 */
export function parseIsoDuration(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const match =
    /^\s*P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?\s*$/i.exec(
      raw,
    );
  if (!match) {
    return null;
  }

  const [, days, hours, minutes, seconds] = match;
  if (
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    // A bare `P` (or `PT`) parses but says nothing.
    return null;
  }

  const total =
    number(days) * 24 * 60 +
    number(hours) * 60 +
    number(minutes) +
    number(seconds) / 60;

  return usableMinutes(Math.round(total));
}

/** «1 ч 20 мин» → 80 · «30 минут» → 30 · «полтора часа» → `null`. */
export function parseRussianDuration(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const text = raw.toLowerCase().replace(/ё/g, "е");
  let total = 0;
  let seen = false;

  // Hours first, then minutes, so «1 ч 20 мин» is not read as one minute.
  //
  // `(?![a-zа-я])` rather than `\b`: JavaScript's word boundary is ASCII-only,
  // so «ч\b» does *not* match «1 ч » — the boundary between a Cyrillic letter
  // and a space is, to that regex, no boundary at all. Every duration on a
  // Russian page would come back null, silently.
  for (const [pattern, factor] of [
    [/(\d+(?:[.,]\d+)?)\s*(?:часов|часа|час|ч|hours|hour|h)(?![a-zа-я])/g, 60],
    [
      /(\d+(?:[.,]\d+)?)\s*(?:минуты|минута|минут|мин|м|minutes|min)(?![a-zа-я])/g,
      1,
    ],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      const value = number(match[1]);
      if (Number.isFinite(value)) {
        total += value * factor;
        seen = true;
      }
    }
  }

  return seen ? usableMinutes(Math.round(total)) : null;
}

/** ISO first, Russian prose second — whichever the page happened to use. */
export function parseDurationMin(raw: string | null): number | null {
  return parseIsoDuration(raw) ?? parseRussianDuration(raw);
}

function number(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function usableMinutes(total: number): number | null {
  return total >= 1 && total <= MAX_MINUTES ? total : null;
}
