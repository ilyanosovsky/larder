"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useState,
  type Ref,
} from "react";

import {
  canStepQty,
  formatQtyNumber,
  parseTypedQty,
  stepQty,
} from "@/lib/cart/qty-step";
import { UNITS, type Unit } from "@/lib/units";

import styles from "./qty-stepper.module.css";

/**
 * A caller-side handle for flushing whatever the shopper is mid-typing,
 * synchronously, before an action that needs the number *right now* rather
 * than on the component's next render.
 *
 * Why this exists: the field commits on blur/Enter on its own, and tapping
 * a sheet's primary button usually blurs the field first anyway (a mousedown
 * on the button moves focus away). "Usually" is not good enough for a value
 * that is about to be written to the cart, though — a touch-driven tap can
 * reach the button's `onClick` without that blur ever firing. `commitPending`
 * is the explicit version of the same commit `resolveAndCommit` already
 * does internally, and it **returns** the resolved number instead of only
 * calling `onQtyChange`: a caller that read its own `qty` state right after
 * calling this would still see the *previous* render's value, because
 * `onQtyChange` schedules a state update rather than applying one inline.
 */
export interface QtyStepperHandle {
  /**
   * Parses the field's current text and returns the number to use. A parse
   * failure reverts the field to the last valid value (showing the inline
   * hint, same as blur) and returns that last valid value — the caller
   * proceeds with the last-known-good quantity rather than being blocked by
   * a stray typo.
   */
  commitPending: () => number;
}

/**
 * The «сколько нужно» stepper + unit picker (DESIGN_BRIEF S4, mockup #1g).
 *
 * Extracted out of `AutocompleteSheet` (task 2.5) so the row action sheet's
 * qty/unit editor can reuse the exact same control rather than a second copy
 * of it — the two must never quietly drift apart on step size or bounds.
 *
 * Task Б4 turned the plain `<span>` value display into a typeable
 * `<input>`: a shopper who needs 250 g should never have to tap «+» 250
 * times. The input keeps its own draft text (`text`) separate from the
 * numeric `qty` prop — a keystroke like «0,» is not yet a valid number, and
 * forcing every keystroke through `onQtyChange` would either reject it or
 * round it out from under the shopper's fingers. The draft commits (calls
 * `onQtyChange`) on blur, on Enter, and — via the imperative handle — right
 * before a caller's own primary action. It resyncs to `formatQtyNumber(qty)`
 * whenever `qty` changes from *outside* typing (a «+»/«−» tap, or a caller
 * resetting the field on open), which is exactly what the `useEffect` below
 * depending only on `qty` catches.
 *
 * Deliberately takes its aria-label strings as props rather than calling
 * `useTranslations` itself: S4 and the row sheet read from different
 * `next-intl` namespaces (`autocomplete` and `cart`), and a shared
 * presentational component has no business picking one for the other.
 */
export function QtyStepper({
  ref,
  qty,
  unit,
  onQtyChange,
  onUnitChange,
  decreaseAria,
  increaseAria,
  unitLabel,
  qtyInputAria,
  invalidHint,
}: {
  ref?: Ref<QtyStepperHandle>;
  qty: number;
  unit: Unit;
  onQtyChange: (qty: number) => void;
  onUnitChange: (unit: Unit) => void;
  decreaseAria: string;
  increaseAria: string;
  unitLabel: string;
  /** aria-label for the typeable value field. */
  qtyInputAria: string;
  /** Shown under the field when a typed entry could not be parsed. */
  invalidHint: string;
}) {
  const unitFieldId = useId();
  const [text, setText] = useState(() => formatQtyNumber(qty));
  const [invalid, setInvalid] = useState(false);

  // Resyncs the draft to the committed value whenever `qty` changes from
  // outside a keystroke — a «+»/«−» tap (which calls `onQtyChange` directly,
  // bypassing the draft entirely) or a caller resetting the field when a new
  // line/row opens. A successful in-field commit also lands here: it calls
  // `onQtyChange`, the caller's `qty` state updates, and this effect reformats
  // the draft from the number that was actually stored (so «0.5» typed with a
  // dot redraws as «0,5»). It deliberately does *not* depend on `unit`:
  // `qtyForUnitChange` (the callers' own unit-switch rule) may leave the
  // number itself unchanged, and reformatting mid-typing whenever the select
  // fires would fight the shopper's fingers for no reason.
  useEffect(() => {
    setText(formatQtyNumber(qty));
    setInvalid(false);
  }, [qty]);

  function resolveAndCommit(): number {
    const parsed = parseTypedQty(text, unit);
    if (parsed === null) {
      setInvalid(true);
      setText(formatQtyNumber(qty));
      return qty;
    }
    setInvalid(false);
    if (parsed !== qty) {
      onQtyChange(parsed);
    }
    return parsed;
  }

  useImperativeHandle(ref, () => ({ commitPending: resolveAndCommit }));

  return (
    <>
      <div className={styles.quantityRow}>
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.stepperButton}
            onClick={() => onQtyChange(stepQty(qty, -1, unit))}
            disabled={!canStepQty(qty, -1, unit)}
            aria-label={decreaseAria}
          >
            −
          </button>

          <input
            className={styles.stepperInput}
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            aria-label={qtyInputAria}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (invalid) {
                setInvalid(false);
              }
            }}
            onBlur={resolveAndCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // No `<form>` wraps this field, so nothing would otherwise
                // submit on Enter — the `preventDefault` guards a caller
                // that adds one later, and the `blur()` closes the
                // on-screen keyboard the way `enterKeyHint="done"` promises
                // it will.
                event.preventDefault();
                resolveAndCommit();
                event.currentTarget.blur();
              }
            }}
          />

          {/* The live region announces the *committed* value, not every
              keystroke — `qty`, not `text`. Announcing each character typed
              would drown a screen reader in noise; announcing the settled
              number (after a tap or a commit) is what the original plain
              `<span aria-live>` did, kept as its own node because an
              `<input>` does not reliably participate in `aria-live` the way
              a text node does. */}
          <span className={styles.srOnly} aria-live="polite">
            {formatQtyNumber(qty)}
          </span>

          <button
            type="button"
            className={styles.stepperButton}
            onClick={() => onQtyChange(stepQty(qty, 1, unit))}
            disabled={!canStepQty(qty, 1, unit)}
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

      {invalid ? (
        <p className={styles.hint} role="status">
          {invalidHint}
        </p>
      ) : null}
    </>
  );
}
