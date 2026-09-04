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
 * Whether the current pointer is touch-shaped — checked at the moment Enter
 * is pressed, not once at mount, matching `pantry-screen.tsx`'s own
 * `prefersReducedMotion` helper (same guard, same reasoning: this only ever
 * runs from a keyboard event in the browser, but the defensive check costs
 * nothing).
 */
function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

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
  const fieldId = useId();
  const hintId = `${fieldId}-qty-error`;
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
    // Always reformats the draft from the parsed number — not only when it
    // differs from `qty` — because the `[qty]` effect below fires on neither
    // of two cases this leaves otherwise stale: a typed value that rounds
    // back to the current `qty` (a discrete unit's «2,4» → 2 on an already-2
    // line) and mere reformatting («0.5» on an already-0,5 line). Both leave
    // the raw typed characters on screen, indefinitely in `CartItemSheet`
    // (the sheet does not remount the stepper after «Сохранить»), until a
    // stray «+»/«−» tap or a reopen happens to trigger a resync.
    setText(formatQtyNumber(parsed));
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
            onClick={() => {
              // Steps from the *draft*, not the stale `qty` prop: on WebKit
              // (and macOS Firefox) a `<button>` tap does not blur the
              // focused input first, so a typed-but-uncommitted value would
              // otherwise be silently replaced by a step taken from the
              // number that was there before typing started.
              // `resolveAndCommit` also covers the ordinary case (nothing
              // pending) by returning `qty` unchanged.
              const base = resolveAndCommit();
              if (canStepQty(base, -1, unit)) {
                onQtyChange(stepQty(base, -1, unit));
              }
            }}
            // `aria-disabled`, never the `disabled` attribute: this button
            // sits inside `BottomSheet`'s focus trap, whose focusable
            // selector excludes `[disabled]` — disabling the button that
            // currently holds focus would drop focus to `<body>`, outside
            // the dialog, in a single keyboard press. The guard above (not
            // the attribute) is what actually enforces the floor.
            aria-disabled={!canStepQty(qty, -1, unit) || undefined}
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
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={hintId}
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
                // that adds one later.
                event.preventDefault();
                resolveAndCommit();
                // Blurring closes the on-screen keyboard `enterKeyHint="done"`
                // promises — worth it on a touch device, where there is no
                // Tab order to lose. On a keyboard/mouse session it would
                // blur to `<body>`, outside the sheet's `aria-modal` panel,
                // recoverable only by the next Tab (which the trap then
                // sends to the header ✕ rather than back here) — so there
                // Enter commits and leaves focus exactly where it was,
                // matching what Tab would do anyway.
                if (isCoarsePointer()) {
                  event.currentTarget.blur();
                }
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
            onClick={() => {
              const base = resolveAndCommit();
              if (canStepQty(base, 1, unit)) {
                onQtyChange(stepQty(base, 1, unit));
              }
            }}
            aria-disabled={!canStepQty(qty, 1, unit) || undefined}
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

      {/* Mounted for the field's whole life, not only while invalid — a
          `role="status"` node that appears together with its content is not
          reliably announced, since assistive tech has to already be
          watching the region before the text arrives (same pattern as
          `import-screen.tsx`'s own hint/error pair). Sr-only when there is
          nothing to say, so sighted users see nothing change but
          `aria-describedby` always resolves to a real node. */}
      <p
        id={hintId}
        className={invalid ? styles.hint : styles.srOnly}
        role="status"
      >
        {invalid ? invalidHint : ""}
      </p>
    </>
  );
}
