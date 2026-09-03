"use client";

import { useTranslations } from "next-intl";

import {
  formatTimerClock,
  timerMessage,
  type TimerDisplay,
  type TimerRunState,
} from "@/lib/recipes/timer";

import styles from "./cook-timer.module.css";

/**
 * One step's timer control (DESIGN_BRIEF S9): «⏱ 9–11 мин · запустить»
 * before it starts, a running digital clock while it counts down, and a
 * «Готово!» card once it hits zero.
 *
 * **Purely presentational — no interval, no `localStorage`, no `<audio>`
 * element of its own**, despite this task's brief describing those as
 * belonging to `cook-timer.tsx`. `cooking-overlay.tsx` owns all three
 * instead, and that is a deliberate change from the brief, not an
 * oversight — see that file's own doc comment for the full reasoning. In
 * short: this component is re-mounted (a fresh instance, `key`ed by the
 * step) every time the cook navigates to a different step, so anything it
 * owned locally — a primed `<audio>` element in particular, which iOS only
 * ever unlocks once per element from a real user gesture — would have to be
 * re-primed after every single step change. The overlay's own single
 * instance never remounts for the session's whole life, so priming happens
 * exactly once and survives freely walking back and forth through the
 * steps.
 */
export function CookTimer({
  display,
  runState,
  remainingMs,
  blockedByOtherStep,
  onStart,
  onReset,
}: {
  display: TimerDisplay;
  /** `null` before the cook has tapped «запустить» at all. */
  runState: TimerRunState | null;
  /** `null` unless `runState === "running"`. */
  remainingMs: number | null;
  /** A *different* step's timer is currently running — starting a second one is refused rather than silently abandoning the first. */
  blockedByOtherStep: boolean;
  onStart: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("cooking");
  const td = useTranslations("dish");
  const message = timerMessage(display);
  const label = td(message.key, message.values);

  if (runState === "running") {
    return (
      <div className={styles.running}>
        <span className={styles.clock} aria-label={t("timerRunningAria")}>
          {formatTimerClock(remainingMs ?? 0)}
        </span>
      </div>
    );
  }

  if (runState === "finished") {
    return (
      <div className={styles.finished}>
        {/* The authoritative announcement lives in `cooking-overlay.tsx`'s
            own permanent live region (fires exactly once, regardless of
            which step happens to be on screen when the timer actually
            rings); this `role="alert"` is the visible confirmation for
            whoever *is* looking at this step at the time. */}
        <p className={styles.finishedText} role="alert">
          {t("timerFinished")}
        </p>
        <button type="button" className={styles.resetButton} onClick={onReset}>
          {t("timerReset")}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.idle}>
      <button
        type="button"
        className={styles.startButton}
        aria-disabled={blockedByOtherStep || undefined}
        onClick={blockedByOtherStep ? undefined : onStart}
      >
        <span aria-hidden="true">⏱</span> {t("timerStart", { label })}
      </button>
      {blockedByOtherStep ? (
        <p className={styles.blockedHint}>{t("timerBusy")}</p>
      ) : null}
    </div>
  );
}
