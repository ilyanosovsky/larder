"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { BottomSheet } from "@/components/bottom-sheet";
import { NeedsReviewChip } from "@/components/needs-review-chip";
import { useSheetOpener } from "@/components/use-sheet-opener";
import { cx } from "@/lib/cx";
import { portionsDisplay } from "@/lib/recipes/portions";
import { formatRecipeQty, rescaleQty } from "@/lib/recipes/rescale";
import type {
  DishDetailOutput,
  DishIngredientOutput,
} from "@/server/api/routers/dish";
import { isUnquantifiable } from "@/server/recipes/needs-review";
import { useTRPC } from "@/trpc/client";

import styles from "./dish-screen.module.css";

/** Which panel the «…» sheet is showing. */
type SheetView = "menu" | "confirm";

/**
 * S7 «Карточка блюда» (DESIGN_BRIEF S7, VISION §3.3) — the read-only view of
 * one dish: photo, title, tags, portions, ingredients and steps.
 *
 * **The four big actions are `aria-disabled` and say «скоро».** «В меню
 * недели» is task 5.1, «Ингредиенты в корзину» is 5.2, «Готовить» is 4.7 and
 * «Редактировать» is 4.2 — and `main` deploys to production on every merge,
 * so a button that navigated nowhere would be worse than one that is honest.
 * `aria-disabled` rather than `disabled` throughout: a disabled control cannot
 * be focused, so a keyboard user would never learn the option exists, and the
 * hint would have nowhere to land.
 *
 * **Quantities go through `formatRecipeQty`, and through `rescaleQty` on the
 * way in.** The portion count is fixed at `portionsBase` here — the slider is
 * task 4.5 — so the rescale is an identity today; routing through it now
 * means 4.5 turns one constant into state instead of rewriting every row.
 *
 * **The three ingredient states must not look alike** (blueprint §4.6): the
 * amber «уточнить» chip means the parser failed, the neutral «опционально»
 * chip means the recipe said so, and «по вкусу» is plain text where the
 * number would be. If they were rendered the same the amber chip would stop
 * meaning anything, which is the only reason it is worth having.
 *
 * **Archiving is confirmed, and reversible from this same screen.** The
 * banner is driven by `archivedAt` on the server's own row rather than by a
 * timed toast: an undo you can still reach a minute later beats one that
 * vanishes in four seconds, and it doubles as the honest rendering of an
 * archived dish somebody opened from Settings.
 */
export function DishScreen({ dishId }: { dishId: string }) {
  const t = useTranslations("dish");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);
  /** Synchronous mutex — render state lands a re-render too late for a double tap. */
  const pendingRef = useRef(false);
  const sheetOpener = useSheetOpener();

  const dishFilter = trpc.dish.get.queryFilter({ id: dishId });
  const dish = useQuery(trpc.dish.get.queryOptions({ id: dishId }));

  function invalidateDish() {
    void queryClient.invalidateQueries(dishFilter);
    void queryClient.invalidateQueries(trpc.dish.list.queryFilter());
    void queryClient.invalidateQueries(trpc.dish.listArchived.queryFilter());
  }

  const archive = useMutation(
    trpc.dish.archive.mutationOptions({
      onSuccess: () => {
        setSheet(null);
        invalidateDish();
      },
      onError: () => setSheetError(t("archiveError")),
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  const unarchive = useMutation(
    trpc.dish.unarchive.mutationOptions({
      onSuccess: invalidateDish,
      onError: () => setHintText(t("undoError")),
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  function setHintText(text: string) {
    hintSeq.current += 1;
    setHint({ text, seq: hintSeq.current });
  }

  function announceSoon(action: string) {
    setHintText(t("soonHint", { action }));
  }

  function confirmArchive(version: number) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setSheetError(null);
    archive.mutate({ id: dishId, expectedVersion: version });
  }

  function undoArchive(version: number) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    unarchive.mutate({ id: dishId, expectedVersion: version });
  }

  if (dish.isPending) {
    return <DishSkeleton label={t("loading")} />;
  }

  if (dish.isError) {
    return (
      <section className={styles.screen}>
        <BackLink label={t("back")} />
        <div className={styles.error} role="alert">
          <p>{t("loadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void dish.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      </section>
    );
  }

  const detail = dish.data;
  const portions = detail.recipe.portionsBase;

  return (
    <section className={styles.screen}>
      <div className={styles.topBar}>
        <BackLink label={t("back")} />
        <button
          type="button"
          className={styles.moreButton}
          aria-label={t("moreAria")}
          onClick={(event) => {
            sheetOpener.captureOpener(event.currentTarget);
            setSheetError(null);
            setSheet("menu");
          }}
        >
          <span aria-hidden="true">…</span>
        </button>
      </div>

      {detail.archivedAt === null ? null : (
        <div className={styles.archivedBanner} role="status">
          <span>{t("archivedBanner")}</span>
          <button
            type="button"
            className={styles.undoButton}
            aria-disabled={unarchive.isPending || undefined}
            onClick={() => undoArchive(detail.version)}
          >
            {unarchive.isPending ? t("undoPending") : t("undo")}
          </button>
        </div>
      )}

      <DishPhoto detail={detail} alt={t("photoAlt", { title: detail.title })} />

      <h1 className={styles.title}>{detail.title}</h1>

      <div className={styles.metaRow}>
        {detail.tags.map((tag) => (
          <span key={tag} className={styles.tag}>
            {tag}
          </span>
        ))}
        <span className={styles.source}>
          {detail.recipe.totalTimeMin === null
            ? null
            : `${t("time", { minutes: detail.recipe.totalTimeMin })} · `}
          {t(`source${sourceKey(detail.sourceType)}`)}
        </span>
        {detail.sourceUrl === null ? null : (
          <a
            className={styles.sourceLink}
            href={detail.sourceUrl}
            target="_blank"
            rel="noreferrer noopener nofollow"
          >
            {t("sourceLink")}
          </a>
        )}
      </div>

      <div className={styles.portionsRow}>
        <span className={styles.portionsLabel}>{t("portionsLabel")}</span>
        <span className={styles.portionsValue}>
          {portionsText(detail, t)}
        </span>
      </div>

      {detail.recipe.adaptedNote === null ? null : (
        <p className={styles.adapted}>
          <span className={styles.adaptedLabel}>{t("adaptedTitle")}</span>
          {detail.recipe.adaptedNote}
        </p>
      )}

      <h2 className={styles.sectionHeader}>
        <span className={styles.sectionName}>{t("ingredientsTitle")}</span>
        <span className={styles.sectionMeta}>
          {ingredientsForText(detail, t)}
        </span>
      </h2>

      {detail.ingredients.length === 0 ? (
        <p className={styles.emptyNote}>{t("ingredientsEmpty")}</p>
      ) : (
        <ul className={styles.rows}>
          {detail.ingredients.map((row) => (
            <li key={row.id}>
              <IngredientRow
                row={row}
                portions={portions}
                base={detail.recipe.portionsBase}
                needsReviewLabel={t("needsReview")}
                optionalLabel={t("optional")}
                inPantryLabel={t("inPantry")}
              />
            </li>
          ))}
        </ul>
      )}

      <h2 className={styles.sectionHeader}>
        <span className={styles.sectionName}>{t("stepsTitle")}</span>
      </h2>

      {detail.steps.length === 0 ? (
        <p className={styles.emptyNote}>{t("stepsEmpty")}</p>
      ) : (
        <ol className={styles.steps}>
          {detail.steps.map((step, index) => (
            <li key={step.id} className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.stepBody}>
                <p className={styles.stepText}>{step.text}</p>
                {step.timerSec === null ? null : (
                  <span className={styles.timer}>{timerText(step, t)}</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.actions}>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.secondaryAction}
            aria-disabled="true"
            onClick={() => announceSoon(t("toMenu"))}
          >
            {t("toMenu")}
          </button>
          <button
            type="button"
            className={styles.secondaryAction}
            aria-disabled="true"
            onClick={() => announceSoon(t("toCart"))}
          >
            {t("toCart")}
          </button>
        </div>
        <button
          type="button"
          className={styles.primaryAction}
          aria-disabled="true"
          onClick={() => announceSoon(t("cook"))}
        >
          {t("cook")}
        </button>
        <button
          type="button"
          className={styles.linkAction}
          aria-disabled="true"
          onClick={() => announceSoon(t("edit"))}
        >
          {t("edit")}
        </button>

        {/* Feedback lands inside the actions block that produced it, not in a
            page-level toast — mounted for the screen's whole life, with a
            keyed child so two identical hints still announce twice. */}
        <p className={styles.srOnly} role="status">
          <span key={hint?.seq ?? "empty"}>{hint?.text ?? ""}</span>
        </p>
        {hint === null ? null : (
          <p className={styles.hint} aria-hidden="true">
            {hint.text}
          </p>
        )}
      </div>

      <BottomSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet === "confirm" ? t("archiveTitle") : t("moreAria")}
        closeLabel={common("close")}
        restoreFocusTo={sheetOpener.restoreFocusTo}
      >
        {sheet === "confirm" ? (
          <div className={styles.confirm}>
            <p className={styles.confirmHint}>{t("archiveHint")}</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => setSheet(null)}
              >
                {common("cancel")}
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                aria-disabled={archive.isPending || undefined}
                onClick={() => confirmArchive(detail.version)}
              >
                {archive.isPending
                  ? t("archiveConfirmPending")
                  : t("archiveConfirm")}
              </button>
            </div>
            {/* Inside the sheet's own aria-modal subtree: a page-level error
                would be behind the scrim and pruned from the a11y tree. */}
            {sheetError === null ? null : (
              <p className={styles.sheetError} role="alert">
                {sheetError}
              </p>
            )}
          </div>
        ) : (
          <ul className={styles.menu}>
            <li>
              <button
                type="button"
                className={styles.menuRow}
                onClick={() => {
                  setSheetError(null);
                  setSheet("confirm");
                }}
              >
                {t("archive")}
              </button>
            </li>
          </ul>
        )}
      </BottomSheet>
    </section>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link href="/dishes" className={styles.back}>
      <span aria-hidden="true">←</span> {label}
    </Link>
  );
}

/** The four `dish.source*` message keys, from the stored enum. */
function sourceKey(sourceType: DishDetailOutput["sourceType"]): string {
  return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
}

type Translate = ReturnType<typeof useTranslations<"dish">>;

/** «8 порций» · «7–8 печений» — four ICU messages, one branch, tested pure. */
function portionsText(detail: DishDetailOutput, t: Translate): string {
  const display = portionsDisplay(detail.recipe);

  if (display.kind === "range") {
    return display.unit === null
      ? t("portionsRange", { from: display.from, to: display.to })
      : t("portionsRangeUnit", {
          from: display.from,
          to: display.to,
          unit: display.unit,
        });
  }

  return display.unit === null
    ? t("portions", { count: display.count })
    : t("portionsUnit", { count: display.count, unit: display.unit });
}

/** «на 8 порций» over the ingredient list (DESIGN_BRIEF S7). */
function ingredientsForText(detail: DishDetailOutput, t: Translate): string {
  const display = portionsDisplay(detail.recipe);

  return display.kind === "range" || display.unit === null
    ? t("ingredientsFor", { count: detail.recipe.portionsBase })
    : t("ingredientsForUnit", {
        count: detail.recipe.portionsBase,
        unit: display.unit,
      });
}

/** «9–11 мин» from two integers, never from a stored Russian label. */
function timerText(
  step: { timerSec: number | null; timerMaxSec: number | null },
  t: Translate,
): string {
  const from = Math.round((step.timerSec ?? 0) / 60);

  return step.timerMaxSec === null
    ? t("timer", { minutes: from })
    : t("timerRange", { from, to: Math.round(step.timerMaxSec / 60) });
}

function DishPhoto({
  detail,
  alt,
}: {
  detail: DishDetailOutput;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);

  if (detail.photoUrl === null || failed) {
    return (
      <div className={styles.photoFrame}>
        <span className={styles.photoPlaceholder} aria-hidden="true">
          🍽
        </span>
      </div>
    );
  }

  return (
    <div className={styles.photoFrame}>
      {/* Same reasoning as `DishCard`: arbitrary remote hosts, no image
          optimization budget, fixed ratio so the page does not reflow. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.photo}
        src={detail.photoUrl}
        alt={alt}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function IngredientRow({
  row,
  portions,
  base,
  needsReviewLabel,
  optionalLabel,
  inPantryLabel,
}: {
  row: DishIngredientOutput;
  portions: number;
  base: number;
  needsReviewLabel: string;
  optionalLabel: string;
  inPantryLabel: string;
}) {
  // Identity while the portion count is fixed at `base` (the slider is task
  // 4.5) — routed through the rescale now so 4.5 only has to make `portions`
  // stateful.
  const qty = rescaleQty(row.qty, portions, base);
  // «Соль по вкусу»: the note *is* the amount, so it belongs in the amount
  // slot rather than as a qualifier after the name.
  const noteIsAmount =
    row.qty === null &&
    !row.needsReview &&
    !row.isOptional &&
    isUnquantifiable(row.note);

  return (
    <div className={cx(styles.row, row.needsReview && styles.rowNeedsReview)}>
      <span className={styles.rowName}>
        {row.name}
        {row.note === null || noteIsAmount ? null : (
          <span className={styles.rowNote}> ({row.note})</span>
        )}
        {row.inPantry ? (
          <span className={styles.rowPantry}> {inPantryLabel}</span>
        ) : null}
      </span>

      {row.needsReview ? (
        <NeedsReviewChip label={needsReviewLabel} />
      ) : row.isOptional ? (
        <span className={styles.rowAmount}>
          {qty === null ? null : (
            <span className={styles.qty}>{formatRecipeQty(qty, row.unit)}</span>
          )}
          <NeedsReviewChip label={optionalLabel} variant="neutral" />
        </span>
      ) : noteIsAmount ? (
        <span className={styles.plainAmount}>{row.note}</span>
      ) : (
        <span className={styles.qty}>{formatRecipeQty(qty, row.unit)}</span>
      )}
    </div>
  );
}

function DishSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.screen} role="status" aria-label={label}>
      <div className={styles.skeletonPhoto} />
      <span className={styles.skeletonTitle} />
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className={styles.skeletonRow}>
          <span className={styles.skeletonName} />
          <span className={styles.skeletonQty} />
        </div>
      ))}
    </div>
  );
}
