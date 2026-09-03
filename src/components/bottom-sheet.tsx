"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import styles from "./bottom-sheet.module.css";

/** Everything that can hold focus inside a sheet. Disabled controls cannot. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The bottom sheet every "add / edit a thing" flow opens from
 * (DESIGN_BRIEF §3): scrim, square paper panel, closes on scrim tap or Esc.
 *
 * Shared rather than re-implemented per screen, because none of the modal
 * behaviour is where a feature's interest lies and all of it is easy to get
 * subtly wrong — an Esc listener that outlives the sheet, focus escaping to
 * the page behind, the page scrolling under a lifted finger. Both S4
 * «Добавление продукта» and the «изменить продукт» mini-sheet sit on this.
 *
 * `aria-modal="true"` is a promise to assistive technology that the rest of
 * the page is inert, so this component has to keep it: focus moves in on
 * open, Tab cycles within the panel, and the element that opened the sheet
 * gets focus back on close.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  closeLabel,
  closeDisabled = false,
  restoreFocusTo,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  /**
   * The caller is holding the sheet open — a write is in flight and its own
   * `onClose` is a no-op for the moment.
   *
   * Esc, the scrim and this ✕ are one handler, so a caller that neutralizes
   * `onClose` neutralizes all three; without this the ✕ would still render as
   * an ordinary enabled button that silently does nothing, while the caller's
   * own body buttons sit visibly `aria-disabled` beside it.
   *
   * `aria-disabled`, never the `disabled` attribute: a disabled control cannot
   * hold focus, and dropping focus out of a focus trap is the bug class this
   * codebase has already paid for once.
   */
  closeDisabled?: boolean;
  /**
   * The control that opened the sheet, from `useSheetOpener()`. Focus returns
   * to it on close. Optional: without it the sheet still traps focus, it just
   * leaves it wherever the browser puts it afterwards.
   */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Held in a ref so the effect below can depend on `open` alone. Callers
  // pass inline arrows (`onClose={() => setEditing(null)}`), so a dependency
  // on `onClose` would re-run the whole effect on every parent render —
  // restoring and re-taking focus each time, which yanks the caret out of
  // whatever the user is typing in.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const panel = panelRef.current;
    // Filled by `useSheetOpener().captureOpener` in the event that opened the
    // sheet, and only read here — after the commit, never during a render.
    const opener = restoreFocusTo?.current ?? null;

    // Only claim focus if nothing inside has it yet: the S4 search field
    // autofocuses itself during the commit, and landing there beats landing
    // on the close button.
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus();
    }

    // One sheet is open at a time in this app, so a plain save/restore is
    // enough — no depth counter.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) {
        // Nothing to tab to — keep focus on the panel rather than letting it
        // fall through to the page behind the scrim.
        event.preventDefault();
        panel.focus();
        return;
      }

      const active = document.activeElement;
      const inside = panel.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Skipped if the opener was unmounted in the meantime (a catalog row
      // replaced by a refetch, say): focusing a detached node silently drops
      // focus on `<body>`, so leaving it where the browser put it is no
      // worse and the check keeps the intent honest.
      if (opener?.isConnected) {
        opener.focus();
      }
    };
    // `restoreFocusTo` is a ref object from `useSheetOpener`, so it is stable
    // across renders and listing it costs no extra runs.
  }, [open, restoreFocusTo]);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.overlay}>
      {/* Presentational: the scrim is a convenience for pointers, and the Esc
          handler above is the keyboard equivalent — so it needs no role of
          its own and must not appear in the tab order. */}
      <div
        className={styles.scrim}
        onClick={closeDisabled ? undefined : onClose}
        aria-hidden="true"
        data-testid="sheet-scrim"
      />
      <div
        ref={panelRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable as a container, but never a tab stop of its own.
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            className={styles.close}
            aria-disabled={closeDisabled || undefined}
            onClick={closeDisabled ? undefined : onClose}
            aria-label={closeLabel}
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
