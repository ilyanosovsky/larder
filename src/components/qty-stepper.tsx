"use client";

import { useId } from "react";

import { canStepQty, QTY_STEP, stepQty } from "@/lib/cart/qty-step";
import { UNITS, type Unit } from "@/lib/units";

import styles from "./qty-stepper.module.css";

/**
 * The «сколько нужно» stepper + unit picker (DESIGN_BRIEF S4, mockup #1g).
 *
 * Extracted out of `AutocompleteSheet` (task 2.5) so the row action sheet's
 * qty/unit editor can reuse the exact same control rather than a second copy
 * of it — the two must never quietly drift apart on step size or bounds.
 *
 * Deliberately takes its aria-label strings as props rather than calling
 * `useTranslations` itself: S4 and the row sheet read from different
 * `next-intl` namespaces (`autocomplete` and `cart`), and a shared
 * presentational component has no business picking one for the other.
 */
export function QtyStepper({
  qty,
  unit,
  onQtyChange,
  onUnitChange,
  decreaseAria,
  increaseAria,
  unitLabel,
}: {
  qty: number;
  unit: Unit;
  onQtyChange: (qty: number) => void;
  onUnitChange: (unit: Unit) => void;
  decreaseAria: string;
  increaseAria: string;
  unitLabel: string;
}) {
  const unitFieldId = useId();

  return (
    <div className={styles.quantityRow}>
      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.stepperButton}
          onClick={() => onQtyChange(stepQty(qty, -QTY_STEP))}
          disabled={!canStepQty(qty, -QTY_STEP)}
          aria-label={decreaseAria}
        >
          −
        </button>
        {/* The live region is the value itself: a stepper's whole output is
            this number, and announcing the two buttons instead would say
            «Больше» without ever saying what it became. */}
        <span className={styles.stepperValue} aria-live="polite">
          {qty}
        </span>
        <button
          type="button"
          className={styles.stepperButton}
          onClick={() => onQtyChange(stepQty(qty, QTY_STEP))}
          disabled={!canStepQty(qty, QTY_STEP)}
          aria-label={increaseAria}
        >
          +
        </button>
      </div>

      <label className={styles.unitLabel} htmlFor={unitFieldId}>
        {unitLabel}
      </label>
      <select
        id={unitFieldId}
        className={styles.unitSelect}
        value={unit}
        onChange={(event) => onUnitChange(event.target.value as Unit)}
      >
        {UNITS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
