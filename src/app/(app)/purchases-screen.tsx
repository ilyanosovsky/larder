"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { cx } from "@/lib/cx";

import { CartScreen } from "./cart-screen";
import { PantryScreen } from "./pantry-screen";
import styles from "./purchases-screen.module.css";

type PurchasesTab = "cart" | "pantry";

/**
 * The «Покупки» tab's own root (DESIGN_BRIEF S3): the «Корзина | Кладовая»
 * segment control, and whichever of the two full screens is currently
 * selected underneath it (task 3.1).
 *
 * The control sits **above** both screens rather than folded into
 * `CartScreen`'s own toolbar. `cart-screen.module.css` had speculated the
 * segment control would replace that toolbar's title/count pair; it does
 * not, on purpose — `CartScreen` is a large, already-tested, actively-synced
 * component (task 2.2–2.5), and reaching into its toolbar to swap out
 * "Корзина" + the item count for a control that also has to drive a sibling
 * screen would mean threading tab state through it for no benefit to the
 * cart itself. A thin wrapper above both screens gets the same DESIGN_BRIEF
 * layout — the control still reads as "the first thing on this tab" — with
 * a far smaller blast radius: neither screen needs to know the other exists.
 *
 * State is local and resets to «Корзина» on remount, matching the plan's own
 * wording ("Local state, default «Корзина»"). Nothing here is persisted
 * across a reload — the pantry is a secondary view, not a screen worth a
 * bookmark of its own in the MVP.
 */
export function PurchasesScreen() {
  const t = useTranslations("purchases");
  const [tab, setTab] = useState<PurchasesTab>("cart");

  return (
    <div className={styles.wrap}>
      <div
        className={styles.segment}
        role="tablist"
        aria-label={t("segmentAria")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cart"}
          className={cx(
            styles.segmentButton,
            tab === "cart" && styles.segmentButtonActive,
          )}
          onClick={() => setTab("cart")}
        >
          {t("cart")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pantry"}
          className={cx(
            styles.segmentButton,
            tab === "pantry" && styles.segmentButtonActive,
          )}
          onClick={() => setTab("pantry")}
        >
          {t("pantry")}
        </button>
      </div>

      {tab === "cart" ? <CartScreen /> : <PantryScreen />}
    </div>
  );
}
