"use client";

import type { CSSProperties } from "react";

import styles from "./portions-slider.module.css";

/**
 * S7's «Порции: N» control (DESIGN_BRIEF S7, mockup #1n): a live-scaling
 * slider plus a pair of ± buttons for a precision a thumb drag cannot land
 * on a 390px screen. Dragging it re-renders every ingredient row through
 * `rescaleQty` — there is no request, and nothing here is persisted.
 *
 * Presentational, like `QtyStepper`: every string arrives translated, so this
 * component never reaches for `useTranslations` and the screen keeps the one
 * place where `dishPortions` copy is composed.
 *
 * **`aria-valuetext` lives on the `<input>` alone.** The ingredient list this
 * control rescales is deliberately not a live region — announcing ten
 * rescaled rows on every drag tick would be unusable — so the slider's own
 * value text («на 8 порций») is the only thing a screen reader says while it
 * moves.
 */
export function PortionsSlider({
  portions,
  min,
  max,
  onChange,
  label,
  valueText,
  decreaseAria,
  increaseAria,
}: {
  portions: number;
  min: number;
  max: number;
  onChange: (portions: number) => void;
  /** «Порции» — the visible caption beside the live count. */
  label: string;
  /** «на 8 порций» / «на 8 печений» — the slider's `aria-valuetext`. */
  valueText: string;
  decreaseAria: string;
  increaseAria: string;
}) {
  function step(delta: number) {
    onChange(Math.min(max, Math.max(min, portions + delta)));
  }

  // WebKit/Blink have no native "filled track" pseudo-element the way Firefox's
  // `::-moz-range-progress` does, so the fill is a gradient painted up to this
  // custom property instead — computed here rather than trusted to CSS
  // `accent-color`, which Paper Ledger's square thumb and thin rule do not use.
  const fillPercent = max > min ? ((portions - min) / (max - min)) * 100 : 100;

  return (
    <div className={styles.row}>
      <span className={styles.label}>
        {label}: <span className={styles.value}>{portions}</span>
      </span>

      <div className={styles.control}>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={decreaseAria}
          disabled={portions <= min}
          onClick={() => step(-1)}
        >
          −
        </button>

        <input
          type="range"
          className={styles.slider}
          min={min}
          max={max}
          step={1}
          value={portions}
          aria-label={label}
          aria-valuetext={valueText}
          onChange={(event) => onChange(Number(event.target.value))}
          // Custom properties are not part of the typed `CSSProperties`
          // surface, so the object needs one assertion rather than a
          // per-property escape hatch. Read by `.slider`'s track gradient.
          style={{ "--fill": `${fillPercent}%` } as CSSProperties}
        />

        <button
          type="button"
          className={styles.stepButton}
          aria-label={increaseAria}
          disabled={portions >= max}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
