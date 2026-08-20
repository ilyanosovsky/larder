"use client";

import { useRef, type RefObject } from "react";

export interface SheetOpener {
  /** Hand to `BottomSheet`'s `restoreFocusTo`. */
  readonly restoreFocusTo: RefObject<HTMLElement | null>;
  /**
   * Call from the handler that opens the sheet, passing the control that was
   * activated — `event.currentTarget`.
   */
  readonly captureOpener: (element: HTMLElement | null) => void;
}

/**
 * Remembers which control opened a sheet, so focus can return to it on close.
 *
 * The capture happens **in the opening event**, which is the only place that
 * both knows the answer and is allowed to look. A sheet cannot work it out
 * for itself afterwards: React applies `autoFocus` during the commit phase,
 * before effects and layout effects alike, so by the time either runs
 * `document.activeElement` is already the sheet's own field. And it must not
 * be captured during render — reading a DOM global and writing a ref there
 * breaks render purity, and a concurrent render that React discards would
 * leave the ref pointing at whatever was focused during a render that never
 * happened.
 *
 * `event.currentTarget` rather than `document.activeElement`: it names the
 * control that was actually activated, which is also correct on browsers
 * that do not focus a `<button>` when it is clicked (Safari).
 */
export function useSheetOpener(): SheetOpener {
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  return {
    restoreFocusTo,
    captureOpener: (element) => {
      restoreFocusTo.current = element;
    },
  };
}
