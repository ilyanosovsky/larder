"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { DraftStep } from "@/lib/recipes/draft";
import {
  minutesFromSeconds,
  parseMinutesInput,
  secondsFromMinutes,
} from "@/lib/recipes/form-fields";

import styles from "./dish-form.module.css";

/** A step timer is a countdown a cook watches, not a cold ferment. */
const MAX_TIMER_MIN = 1440;

/**
 * One editable step of S8.3, with **both** ways to reorder it.
 *
 * The `≡` handle is a pointer drag, because HTML5 drag and drop does not work
 * on iOS and this is a phone-first app. «Выше»/«Ниже» are the path that always
 * works: a drag is unusable with a keyboard or a switch, and a reorder that
 * only exists as a gesture is a reorder some people simply cannot do. Both end
 * in the same `moveItem` call, so they cannot disagree.
 *
 * The timer is two minute fields over two second columns, so S9 can render
 * «9–11 мин» from integers rather than from a stored Russian label.
 */
export function StepEditRow({
  index,
  total,
  value,
  rowRef,
  removeButtonId,
  dragging,
  onChange,
  onRemove,
  onMove,
  onDragStart,
}: {
  index: number;
  total: number;
  value: DraftStep;
  /** Measured by the form to decide where a drag should drop. */
  rowRef: (element: HTMLLIElement | null) => void;
  removeButtonId: string;
  dragging: boolean;
  onChange: (next: DraftStep) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const t = useTranslations("dishForm");
  const fieldId = useId();

  /**
   * Both timer fields hold text for the same reason the quantity field does
   * (see `ingredient-edit-row.tsx`): a controlled input over the parsed value
   * rewrites what is being typed mid-keystroke. The draft still receives the
   * parsed minutes on every change.
   */
  const [timerText, setTimerText] = useState(() =>
    minutesFromSeconds(value.timerSec),
  );
  const [timerMaxText, setTimerMaxText] = useState(() =>
    minutesFromSeconds(value.timerMaxSec),
  );

  function patch(next: Partial<DraftStep>) {
    onChange({ ...value, ...next });
  }

  return (
    <li
      ref={rowRef}
      className={
        dragging ? `${styles.stepRow} ${styles.stepDragging}` : styles.stepRow
      }
    >
      <div className={styles.stepHeader}>
        <span className={styles.stepNumber} aria-hidden="true">
          {index + 1}
        </span>

        {/* A span, not a button: `pointerdown` and `setPointerCapture` work on
            any element, while a button would sit in the tab order with an
            actionable label and do nothing on Enter or Space — Enter fires
            `click`, never `pointerdown`. The keyboard path is ↑/↓ beside it,
            so the handle is pointer-only by design and says so to assistive
            tech rather than pretending otherwise. */}
        <span
          className={styles.dragHandle}
          onPointerDown={onDragStart}
          aria-hidden="true"
        >
          ≡
        </span>

        <button
          type="button"
          className={styles.moveButton}
          onClick={() => onMove(index - 1)}
          aria-label={t("moveUpAria", { position: index + 1 })}
          aria-disabled={index === 0 || undefined}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.moveButton}
          onClick={() => onMove(index + 1)}
          aria-label={t("moveDownAria", { position: index + 1 })}
          aria-disabled={index === total - 1 || undefined}
        >
          ↓
        </button>

        <button
          type="button"
          id={removeButtonId}
          className={styles.rowRemove}
          onClick={onRemove}
          aria-label={t("removeStepAria", { position: index + 1 })}
        >
          ✕
        </button>
      </div>

      <label className={styles.srOnly} htmlFor={`${fieldId}-text`}>
        {t("stepTextLabel", { position: index + 1 })}
      </label>
      <textarea
        id={`${fieldId}-text`}
        className={styles.stepText}
        value={value.text}
        onChange={(event) => patch({ text: event.target.value })}
        placeholder={t("stepTextPlaceholder")}
        maxLength={2000}
        rows={3}
      />

      <div className={styles.timerFields}>
        <label className={styles.inlineLabel} htmlFor={`${fieldId}-timer`}>
          {t("timerLabel")}
        </label>
        <input
          id={`${fieldId}-timer`}
          className={styles.timerInput}
          type="text"
          inputMode="numeric"
          value={timerText}
          onChange={(event) => {
            setTimerText(event.target.value);
            const timerSec = secondsFromMinutes(
              parseMinutesInput(event.target.value, MAX_TIMER_MIN),
            );
            // An upper bound with no lower bound is not a range — it is a
            // countdown S9 could not start, and `recipeDraftSchema` refuses it.
            // The text goes with the value: a max field still showing «11»
            // over a draft that no longer holds one would keep lying, and
            // typing a lower bound back in does not re-parse it.
            if (timerSec === null) {
              setTimerMaxText("");
            }
            patch({
              timerSec,
              timerMaxSec: timerSec === null ? null : value.timerMaxSec,
            });
          }}
          placeholder={t("timerPlaceholder")}
          autoComplete="off"
        />
        <span className={styles.timerDash} aria-hidden="true">
          –
        </span>
        <label className={styles.srOnly} htmlFor={`${fieldId}-timer-max`}>
          {t("timerMaxLabel")}
        </label>
        <input
          id={`${fieldId}-timer-max`}
          className={styles.timerInput}
          type="text"
          inputMode="numeric"
          value={timerMaxText}
          onChange={(event) => {
            setTimerMaxText(event.target.value);
            patch({
              timerMaxSec: secondsFromMinutes(
                parseMinutesInput(event.target.value, MAX_TIMER_MIN),
              ),
            });
          }}
          placeholder={t("timerMaxPlaceholder")}
          autoComplete="off"
        />
        <span className={styles.timerUnit}>{t("timerUnit")}</span>
      </div>
    </li>
  );
}
