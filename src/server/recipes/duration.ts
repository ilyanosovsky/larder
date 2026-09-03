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

/**
 * Anything past this is not a cooking time.
 *
 * Deliberately *looser* than `recipeDraftSchema`'s own `MAX_TOTAL_TIME_MIN`
 * (6 000): this module's job is to say what the page stated, and
 * `draftFromParsed` is the one place that decides what may be stored. A
 * two-day brine reads as 2 880 minutes here and is nulled downstream — which
 * is the right division of labour, because the hint the model sees should
 * describe the page rather than the database.
 */
const MAX_MINUTES = 100_000;

/**
 * Longest string worth reading a duration out of.
 *
 * A real `totalTime` is «PT1H15M» or «1 ч 20 мин»; anything approaching this
 * is a page playing games. The cap is load-bearing rather than tidy: both
 * Russian patterns below are global and alternating, and on a long run of
 * digits they backtrack quadratically — 128 000 digits measured at **51
 * seconds** of synchronous CPU, which no `AbortSignal` can interrupt and
 * which therefore burns the whole `maxDuration` and returns a 504 with no
 * `jobId`. The page controls this string: `MAX_BLOCK_CHARS` allows a 500 KB
 * ld+json block, and microdata text is bounded only by the 2 MB page cap.
 */
const MAX_DURATION_CHARS = 200;

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
    /^\s*P(?:(\d{1,6}(?:[.,]\d{1,3})?)D)?(?:T(?:(\d{1,6}(?:[.,]\d{1,3})?)H)?(?:(\d{1,6}(?:[.,]\d{1,3})?)M)?(?:(\d{1,6}(?:[.,]\d{1,3})?)S)?)?\s*$/i.exec(
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
  // The digit runs are bounded (`\d{1,6}`) as well as the input: six digits
  // is already past `MAX_MINUTES`, so nothing readable is lost, and no single
  // position can backtrack far even if a future caller skips
  // `parseDurationMin`'s cap.
  //
  // `(?![a-zа-я])` rather than `\b`: JavaScript's word boundary is ASCII-only,
  // so «ч\b» does *not* match «1 ч » — the boundary between a Cyrillic letter
  // and a space is, to that regex, no boundary at all. Every duration on a
  // Russian page would come back null, silently.
  for (const [pattern, factor] of [
    [
      /(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:часов|часа|час|ч|hours|hour|h)(?![a-zа-я])/g,
      60,
    ],
    [
      /(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:минуты|минута|минут|мин|м|minutes|min)(?![a-zа-я])/g,
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

/**
 * ISO first, Russian prose second — whichever the page happened to use.
 *
 * **The single choke point for the length cap.** Every caller in the cascade
 * comes through here, so bounding the string once is what keeps a hostile
 * page from spending a minute of CPU inside a regex (see
 * `MAX_DURATION_CHARS`).
 */
export function parseDurationMin(raw: string | null): number | null {
  const capped = raw === null ? null : raw.slice(0, MAX_DURATION_CHARS);
  return parseIsoDuration(capped) ?? parseRussianDuration(capped);
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
