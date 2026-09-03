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
 *
 * **Task 4.7 extends this file rather than adding a second timer module**
 * (its own addendum): the countdown itself — `startTimer`, `timerRemainingMs`,
 * `timerState`, `formatTimerClock` — belongs beside `timerDisplay`/
 * `timerMessage` because both halves describe the exact same pair of stored
 * integers, just for two different moments (the label before a timer starts,
 * the clock while it runs). The cooking overlay's «⏱ 9–11 мин · запустить»
 * button reuses `timerDisplay`/`timerMessage` verbatim for its own label —
 * there is deliberately no second `formatTimerLabelParts`, which would only
 * ever recompute the same branch this file already gets right.
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

/**
 * Which `dish.timer*` message a step's countdown should render, and with what.
 *
 * Same reasoning as `ingredientsForMessage` (`src/lib/recipes/portions.ts`):
 * the four-way choice between minutes and seconds, single value and range, is
 * the part that can silently invert — a swapped sec/min branch renders a
 * 30-second step as «30 мин» — and a branch inside a component is unreachable
 * from a node-only test suite. Task 4.7's overlay picks its label from the
 * same function.
 */
export type TimerMessage =
  | { key: "timer"; values: { minutes: number } }
  | { key: "timerSeconds"; values: { seconds: number } }
  | { key: "timerRange"; values: { from: number; to: number } }
  | { key: "timerSecondsRange"; values: { from: number; to: number } };

export function timerMessage(display: TimerDisplay): TimerMessage {
  if (display.kind === "single") {
    return display.unit === "sec"
      ? { key: "timerSeconds", values: { seconds: display.value } }
      : { key: "timer", values: { minutes: display.value } };
  }

  return display.unit === "sec"
    ? {
        key: "timerSecondsRange",
        values: { from: display.from, to: display.to },
      }
    : { key: "timerRange", values: { from: display.from, to: display.to } };
}

/**
 * A running countdown, wall-clock-anchored (DESIGN_BRIEF S9, VISION §6.6).
 *
 * **Never an accumulated interval.** A `setInterval` that subtracts a tick's
 * length from a remembered "seconds left" drifts the instant the tab is
 * backgrounded — mobile browsers throttle (or fully suspend) timers on a
 * hidden tab, so a `setInterval(fn, 250)` due to fire 240 times across a
 * 60-second bake might fire twice. `startTimer` instead records *when the
 * timer ends* (`endsAt`, an epoch-ms timestamp); every render re-derives
 * "how much is left" from `endsAt - Date.now()`, which is correct however
 * long the tick loop itself was actually suspended for. `cooking-overlay.tsx`
 * ticks at 250ms purely to force a re-render — the number it computes each
 * time is exact regardless of whether the previous tick fired on schedule.
 *
 * `sec` is the step's *lower* bound (`recipe_steps.timer_sec`) — the cooking
 * overlay always counts down from there, never the upper bound, matching how
 * a cook actually uses a range: «9–11 мин» means set a timer for 9 and start
 * checking.
 */
export function startTimer(nowMs: number, sec: number): { endsAt: number } {
  // `Math.max(0, sec)`: a zero or negative duration (a corrupt row —
  // `recipeDraftSchema` refuses this at save time, but the column itself
  // has no CHECK constraint) still returns a real `endsAt`, one that reads
  // back as immediately finished rather than counting backwards forever.
  return { endsAt: nowMs + Math.max(0, sec) * 1000 };
}

/** Never negative — the floor is what turns "past `endsAt`" into "finished" rather than a clock counting through zero into negative numbers. */
export function timerRemainingMs(endsAt: number, nowMs: number): number {
  return Math.max(0, endsAt - nowMs);
}

export type TimerRunState = "running" | "finished";

/**
 * `"finished"` at and past `endsAt` — including a persisted `endsAt` that was
 * already in the past the moment it was restored (the tab was closed mid-bake
 * and reopened an hour later). There is no third "not started" state here on
 * purpose: a timer that was never started has no `endsAt` at all, so the
 * caller simply never calls this for it.
 */
export function timerState(endsAt: number, nowMs: number): TimerRunState {
  return timerRemainingMs(endsAt, nowMs) > 0 ? "running" : "finished";
}

/** Zero-padded, always at least two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * «09:00» under an hour, «01:00:00» at or above one — a plain digital clock,
 * not an ICU message (there is no plural or word to localize in a stopwatch
 * readout).
 *
 * `Math.ceil`, not `Math.floor` or `Math.round`: a countdown started for
 * exactly 9 minutes should read «09:00» for the whole first second it is
 * running, not jump to «08:59» (floor) or drop straight to «00:00» for the
 * last sub-second remainder (round) while `timerState` still reports
 * "running". Ceiling still lands on «00:00» exactly at (and past) `endsAt`,
 * since `timerRemainingMs` already floors at zero — `Math.ceil(0 / 1000)`
 * is `0`, never `-0` or negative.
 */
export function formatTimerClock(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}
