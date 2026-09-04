"use client";

import { useTranslations } from "next-intl";

import styles from "./past-weeks-section.module.css";

/**
 * «Прошлые недели» — the collapsed block at the bottom of S10
 * (DESIGN_BRIEF S10: «свёрнутый список внизу», action «Повторить неделю»).
 *
 * **A placeholder in its own file, for the reason `build-cart-button.tsx` is
 * one**: task 5.3 replaces this component and its stylesheet with the real
 * `menu.history` list, and owning both from day one is what keeps that PR out
 * of `menu-screen.tsx`.
 *
 * It renders unconditionally, including on an empty week: a fresh Monday is
 * exactly when repeating last week is the useful move, so hiding the block
 * behind a non-empty pool would hide it at the only moment it matters.
 *
 * The toggle is `aria-disabled` rather than `disabled` and announces «скоро»
 * through the screen's own live region — `main` deploys to production on
 * every merge, and a disclosure that opened onto nothing would be worse than
 * one that says so. `aria-expanded="false"` is the honest state: it is a
 * disclosure, it is closed, and 5.3 makes it open.
 */
export function PastWeeksSection({
  onAnnounce,
}: {
  /** The screen's live region — this toggle has nothing else to show for a tap. */
  onAnnounce: (text: string) => void;
}) {
  const t = useTranslations("menuHistory");
  const tm = useTranslations("menu");

  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.toggle}
        aria-disabled="true"
        aria-expanded={false}
        onClick={() => onAnnounce(tm("soonHint", { action: t("title") }))}
      >
        <span className={styles.marker} aria-hidden="true">
          ▸
        </span>
        {t("title")}
      </button>
    </section>
  );
}
