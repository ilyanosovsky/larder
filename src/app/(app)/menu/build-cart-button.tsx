"use client";

import { useTranslations } from "next-intl";

import styles from "./build-cart-button.module.css";

/** The one field the hint decision needs; a `menu.current` row satisfies it. */
export interface BuildCartItem {
  cookedAt: Date | null;
}

/**
 * S10's primary action, «Собрать корзину» (DESIGN_BRIEF S10).
 *
 * **Its own file, with its own stylesheet, from the day it is a placeholder.**
 * Task 5.2 replaces this component wholesale with the real opener, the
 * MergePreview sheet and the «В корзине +N» toast; giving it a file of its
 * own is what keeps that PR out of `menu-screen.tsx` and out of the screen's
 * stylesheet, so 5.2 and 5.3 can be written side by side.
 *
 * **`aria-disabled`, never `disabled`, in all three states.** A disabled
 * control cannot be focused, so a keyboard user would never learn the action
 * exists and the hint explaining why it is unavailable would have nowhere to
 * land. The two real refusals are knowable from `menu.current` alone, which
 * is what keeps 5.2's sheet from ever opening on a preview that could only be
 * empty; the third is this task's own honest «скоро».
 */
export function BuildCartButton({
  items,
  onAnnounce,
}: {
  items: readonly BuildCartItem[];
  /** The screen's live region — this button has nothing else to show for a tap. */
  onAnnounce: (text: string) => void;
}) {
  const t = useTranslations("menu");
  const label = t("build");

  function hint(): string {
    if (items.length === 0) {
      return t("buildEmpty");
    }
    if (items.every((item) => item.cookedAt !== null)) {
      return t("buildAllCooked");
    }
    // Task 5.2's «скоро», worded exactly as S7 words its own pending actions.
    return t("soonHint", { action: label });
  }

  return (
    <button
      type="button"
      className={styles.build}
      aria-disabled="true"
      onClick={() => onAnnounce(hint())}
    >
      {label}
    </button>
  );
}
