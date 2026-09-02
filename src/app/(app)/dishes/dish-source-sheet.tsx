"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, type RefObject } from "react";

import { BottomSheet } from "@/components/bottom-sheet";

import styles from "./dish-library-screen.module.css";

/**
 * «+ Блюдо» → the four ways to add one (DESIGN_BRIEF S6, in exactly this
 * order — photo first, because a screenshot is the main road).
 *
 * **Every row is `aria-disabled` in task 4.1 and announces «скоро».** The
 * routes behind them do not exist yet: `/dishes/new` is task 4.2 and
 * `/dishes/import` is 4.3/4.4. `main` auto-deploys to production, so every
 * merged PR has to be shippable — a row linking to a 404 would be worse than
 * a row that says honestly it is not ready.
 *
 * `aria-disabled` rather than `disabled`, the rule this codebase already
 * follows for pending controls: a truly disabled button cannot be focused,
 * so a keyboard user tabbing the sheet would never find out these options
 * exist, and the hint would have no way to reach them.
 *
 * The hint renders **inside** the sheet's own `aria-modal` subtree. A
 * page-level toast would be both hidden behind the scrim and pruned from the
 * accessibility tree — the lesson `revision-mode.tsx` already encodes.
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
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);

  /**
   * The sheet unmounts its own DOM when it closes, but this component stays
   * mounted — so the hint has to be dropped explicitly, or reopening the sheet
   * would mount the live region with a stale «скоро» already inside it and
   * assistive tech would announce a message about a tap from a minute ago.
   * `BottomSheet` routes Esc and the scrim through `onClose` too, so this one
   * handler covers every way out.
   */
  function close() {
    setHint(null);
    onClose();
  }

  function announce(action: string) {
    hintSeq.current += 1;
    setHint({ text: t("soonHint", { action }), seq: hintSeq.current });
  }

  const sources = [
    { key: "photo", icon: "📷", label: t("sourcePhoto"), hint: t("sourcePhotoHint") },
    { key: "url", icon: "🔗", label: t("sourceUrl"), hint: null },
    { key: "text", icon: "📝", label: t("sourceText"), hint: null },
    {
      key: "manual",
      icon: "✍️",
      label: t("sourceManual"),
      hint: t("sourceManualHint"),
    },
  ] as const;

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={t("sourceTitle")}
      closeLabel={common("close")}
      restoreFocusTo={restoreFocusTo}
    >
      <ul className={styles.sourceList}>
        {sources.map((source) => (
          <li key={source.key}>
            <button
              type="button"
              className={styles.sourceRow}
              aria-disabled="true"
              onClick={() => announce(source.label)}
            >
              <span className={styles.sourceIcon} aria-hidden="true">
                {source.icon}
              </span>
              <span className={styles.sourceText}>
                <span className={styles.sourceLabel}>{source.label}</span>
                {source.hint === null ? null : (
                  <span className={styles.sourceHint}>{source.hint}</span>
                )}
              </span>
              <span className={styles.sourceSoon}>{t("soon")}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Mounted for the sheet's whole life so assistive tech is already
          watching it before any text arrives; the keyed child forces a real
          node replacement when two identical hints follow each other (the
          same reasoning S3's and S5's live regions document). */}
      <p className={styles.sheetStatus} role="status">
        <span key={hint?.seq ?? "empty"}>{hint?.text ?? ""}</span>
      </p>
    </BottomSheet>
  );
}
