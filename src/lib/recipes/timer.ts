/**
 * How a step's countdown is written out (DESIGN_BRIEF S9: «9–11 мин»).
 *
 * The numbers are stored as two integers — `recipe_steps.timer_sec` and
 * `timer_max_sec` — precisely so no Russian label ever lives in the database;
 * this module decides *which* label to ask next-intl for, and with what.
 *
 * Pure and shared: S7 renders the label beside a step, and task 4.7's cooking
 * overlay renders the same label above a running countdown. One function, so
 * a step cannot describe itself differently in the two places.
 */

/** A minute, in seconds — the unit the label switches at. */
const SECONDS_PER_MINUTE = 60;

export type TimerDisplay =
  | { kind: "single"; unit: "sec" | "min"; value: number }
  | { kind: "range"; unit: "sec" | "min"; from: number; to: number };

/**
 * `null` when the step has no timer at all.
 *
 * Two rules, both about never printing a confident zero — the same rule
 * `formatRecipeQty` enforces for quantities:
 *
 * - **Under a minute stays in seconds.** «30 сек» is what the recipe said;
 *   «0 мин» and «1 мин» are both lies, one absurd and one plausible enough to
 *   be followed.
 * - **Above a minute, the minute value floors at 1.** A 70-second lower bound
 *   rounds to 1, and a range whose lower bound would round to 0 («20–90 сек»)
 *   still reports at least a minute rather than «0–2 мин».
 *
 * A range whose bounds collapse to the same rendered number («540–560 сек» →
 * 9 minutes either way) comes back as a single value: «9–9 мин» is not a
 * range, it is a rounding artefact. An upper bound that is not actually above
 * the lower one is dropped for the same reason — the column has no CHECK
 * constraint, so a row can hold one even though `recipeDraftSchema` refuses.
 */
export function timerDisplay(
  timerSec: number | null,
  timerMaxSec: number | null,
): TimerDisplay | null {
  if (timerSec === null || !Number.isFinite(timerSec) || timerSec <= 0) {
    return null;
  }

  const upper =
    timerMaxSec !== null &&
    Number.isFinite(timerMaxSec) &&
    timerMaxSec > timerSec
      ? timerMaxSec
      : null;

  if ((upper ?? timerSec) < SECONDS_PER_MINUTE) {
    return upper === null
      ? { kind: "single", unit: "sec", value: Math.round(timerSec) }
      : {
          kind: "range",
          unit: "sec",
          from: Math.round(timerSec),
          to: Math.round(upper),
        };
  }

  const from = toMinutes(timerSec);

  if (upper === null) {
    return { kind: "single", unit: "min", value: from };
  }

  const to = toMinutes(upper);

  return from === to
    ? { kind: "single", unit: "min", value: from }
    : { kind: "range", unit: "min", from, to };
}

/** Never zero: a countdown that is running has at least a minute left to show. */
function toMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE));
}
