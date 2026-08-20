"use client";

import { useEffect, type ReactNode } from "react";

import styles from "./bottom-sheet.module.css";

/**
 * The bottom sheet every "add / edit a thing" flow opens from
 * (DESIGN_BRIEF §3): scrim, square paper panel, closes on scrim tap or Esc.
 *
 * Shared rather than re-implemented per screen, because the dismissal
 * behaviour is the part that is easy to get subtly wrong — an Esc listener
 * that outlives the sheet, or a scrim that swallows taps meant for the panel.
 * Both S4 «Добавление продукта» and the «изменить продукт» mini-sheet sit on
 * this.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

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
        onClick={onClose}
        aria-hidden="true"
        data-testid="sheet-scrim"
      />
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
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
