import type { TimerRunState } from "@/lib/recipes/timer";

/**
 * Step navigation and persisted-state parsing for S9 cooking mode
 * (DESIGN_BRIEF S9, task 4.7). Pure and unit-tested — `cooking-overlay.tsx`
 * is the only caller, but none of this needs a DOM to get right, and this
 * repo has no jsdom/RTL harness to catch a flipped branch inside a `.tsx`.
 */

export type StepNavAction =
  | { readonly type: "next" }
  | { readonly type: "prev" }
  | { readonly type: "goto"; readonly index: number };

/**
 * The next step index for a button tap, an arrow key, a committed swipe, or
 * the header's "jump to the step with the running timer" chip — clamped at
 * both ends so none of those callers has to special-case the first/last
 * step itself. `total <= 0` (a dish saved with no steps at all) always
 * returns `0`, since there is nothing to clamp into.
 */
export function stepNavigation(
  current: number,
  total: number,
  action: StepNavAction,
): number {
  if (total <= 0) {
    return 0;
  }

  const target =
    action.type === "next"
      ? current + 1
      : action.type === "prev"
        ? current - 1
        : action.index;

  return Math.min(Math.max(target, 0), total - 1);
}

/**
 * Whether leaving the overlay right now needs the inline exit confirmation
 * (blueprint §4.7 / this task's addendum): past the first step, or with a
 * timer actually still counting down. A *finished* timer does not gate the
 * exit — there is nothing left to lose by leaving once it has already rung.
 *
 * `timerRunState` is `null` when no timer was ever started this session —
 * kept as a separate, explicit case from `"finished"` rather than folding
 * "no timer" and "timer done" into one falsy check, so a future third state
 * cannot silently start passing this gate by accident.
 */
export function needsExitConfirmation(
  stepIndex: number,
  timerRunState: TimerRunState | null,
): boolean {
  return stepIndex > 0 || timerRunState === "running";
}

/** One running (or just-finished) timer, and which step started it. */
export interface CookTimerState {
  readonly endsAt: number;
  readonly stepIndex: number;
}

/**
 * Which step's start button, if any, is blocked by a timer *actually
 * counting down* on a different step — `null` when nothing is running, or
 * when the running timer belongs to `currentStepIndex` itself (that step's
 * own control shows the running clock, not a blocked start button).
 *
 * **A finished timer never blocks.** `timer` stays non-null past `endsAt`
 * until the cook taps «Сбросить» (`resetTimer`'s the only writer of
 * `timer: null`) or starts a new one, but a step that already rang has
 * nothing left to protect — a different step's «запустить» refusing to
 * start over that stale timer, with a hint claiming something is "still
 * cooking", would be actively misleading. `needsExitConfirmation` above
 * already draws this same running-vs-finished line for the exit gate; this
 * is the same distinction, applied to the start guard and the UI flag.
 */
export function blockingTimerStepIndex(
  timer: CookTimerState | null,
  currentStepIndex: number,
  runState: TimerRunState | null,
): number | null {
  if (timer === null || runState !== "running") {
    return null;
  }
  return timer.stepIndex === currentStepIndex ? null : timer.stepIndex;
}

/** What `larder.cook.<dishId>` holds between opens of the cooking overlay. */
export interface CookingState {
  readonly stepIndex: number;
  readonly timer: CookTimerState | null;
}

const FRESH_STATE: CookingState = { stepIndex: 0, timer: null };

/** `0` for anything that is not a plain integer; otherwise clamped into `[0, totalSteps - 1]`. Shared by `stepIndex` and `timer.stepIndex` restoration below. */
function clampStepIndex(value: unknown, totalSteps: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), totalSteps - 1);
}

/**
 * `raw.timer` on its own persisted shape: `{ endsAt, stepIndex }`.
 *
 * **`stepIndex` here is a deliberate addition over the brief's shorthand
 * `{ endsAt }`.** Without recording which step actually started a timer, a
 * session that starts a 9-minute bake on step 3, walks on to step 4, and
 * exits there would restore with `timer.endsAt` attached to whatever step
 * happens to be current on reopen — misattributing a running timer to a step
 * that never had one, or worse, to a step with its *own*, different
 * `timerSec`. One extra integer is cheap; a cooking timer that quietly
 * points at the wrong step is not the kind of bug this app can be honest
 * about later.
 */
function restoreTimer(
  value: unknown,
  totalSteps: number,
): CookTimerState | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.endsAt !== "number" || !Number.isFinite(raw.endsAt)) {
    return null;
  }

  return {
    endsAt: raw.endsAt,
    stepIndex: clampStepIndex(raw.stepIndex, totalSteps),
  };
}

/**
 * Defensively parses whatever `localStorage.getItem("larder.cook.<dishId>")`
 * returned (already `JSON.parse`d, or `null` if the read/parse itself
 * failed — the caller's try/catch handles that half) into a `CookingState`.
 *
 * Garbage in any shape — a string, an array, `{ stepIndex: "two" }`, a
 * `timer` that is not an object — degrades to `FRESH_STATE` (or, for a
 * field that parses independently of the other, to that field's own
 * default) rather than throwing: a corrupt localStorage entry must never be
 * the reason the cooking overlay fails to open.
 *
 * A restored `endsAt` in the past is kept as-is, not specially detected
 * here — `timerState(restored.timer.endsAt, nowMs)` already answers
 * `"finished"` for it (see that function's own doc comment), so there is no
 * second place that rule needs to be encoded.
 */
export function restoreCookingState(
  raw: unknown,
  totalSteps: number,
): CookingState {
  if (totalSteps <= 0 || typeof raw !== "object" || raw === null) {
    return FRESH_STATE;
  }

  const obj = raw as Record<string, unknown>;

  return {
    stepIndex: clampStepIndex(obj.stepIndex, totalSteps),
    timer: restoreTimer(obj.timer, totalSteps),
  };
}
