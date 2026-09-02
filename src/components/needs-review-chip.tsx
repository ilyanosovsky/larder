import { cx } from "@/lib/cx";

import styles from "./needs-review-chip.module.css";

/**
 * The small mono chip an ingredient row wears instead of a quantity
 * (DESIGN_BRIEF §3 NeedsReviewChip).
 *
 * Two variants, and the difference is the whole point (DESIGN_BRIEF §6:
 * «Пометки „уточнить“ жёлтые, не красные»):
 *
 * - `review` — amber (`--null` / `--null-txt`, the design system's "missing
 *   value" family): the parser failed here and a human has to look. Amber and
 *   not red, because nothing is broken — a number is simply unknown.
 * - `neutral` — muted grey: a fact about the row that needs no action
 *   («опционально» on S7, «новый» on the S8.3 form in task 4.2).
 *
 * If both looked alike the amber chip would stop meaning anything, which is
 * exactly what makes it worth having.
 */
export function NeedsReviewChip({
  label,
  variant = "review",
}: {
  label: string;
  variant?: "review" | "neutral";
}) {
  return (
    <span
      className={cx(
        styles.chip,
        variant === "review" ? styles.review : styles.neutral,
      )}
    >
      {label}
    </span>
  );
}
