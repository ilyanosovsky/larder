"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { RefObject } from "react";

import { BottomSheet } from "@/components/bottom-sheet";

import styles from "./dish-library-screen.module.css";

/**
 * «+ Блюдо» → the four ways to add one (DESIGN_BRIEF S6, in exactly this
 * order — photo first, because a screenshot is the main road).
 *
 * All four rows are real links now that task 4.4 has landed the URL and text
 * panes; the «скоро» state and the live region that announced it are gone
 * with them.
 *
 * Each row carries `?src=…`, which is what makes this a router rather than a
 * menu: S8.1 opens with the source already chosen and its field focused, so
 * choosing here costs one tap and not two.
 */
export function DishSourceSheet({
  open,
  onClose,
  restoreFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("dishes");
  const common = useTranslations("common");

  const sources = [
    {
      key: "photo",
      icon: "📷",
      label: t("sourcePhoto"),
      hint: t("sourcePhotoHint"),
      // `?src=photo` lands on S8.1 with the picker focused. It cannot open
      // the file dialog itself: browsers require transient user activation,
      // and a tap that caused a navigation does not carry it across.
      href: "/dishes/import?src=photo",
    },
    {
      key: "url",
      icon: "🔗",
      label: t("sourceUrl"),
      hint: t("sourceUrlHint"),
      href: "/dishes/import?src=url",
    },
    {
      key: "text",
      icon: "📝",
      label: t("sourceText"),
      hint: t("sourceTextHint"),
      href: "/dishes/import?src=text",
    },
    {
      key: "manual",
      icon: "✍️",
      label: t("sourceManual"),
      hint: t("sourceManualHint"),
      href: "/dishes/new",
    },
  ] as const;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("sourceTitle")}
      closeLabel={common("close")}
      restoreFocusTo={restoreFocusTo}
    >
      <ul className={styles.sourceList}>
        {sources.map((source) => (
          <li key={source.key}>
            <Link className={styles.sourceRow} href={source.href}>
              <span className={styles.sourceIcon} aria-hidden="true">
                {source.icon}
              </span>
              <span className={styles.sourceText}>
                <span className={styles.sourceLabel}>{source.label}</span>
                <span className={styles.sourceHint}>{source.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
