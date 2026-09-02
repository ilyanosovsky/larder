"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { BottomSheet } from "@/components/bottom-sheet";
import { NeedsReviewChip } from "@/components/needs-review-chip";
import { useSheetOpener } from "@/components/use-sheet-opener";
import { cx } from "@/lib/cx";
import {
  ingredientsYieldUnit,
  portionsDisplay,
} from "@/lib/recipes/portions";
import { formatRecipeQty, rescaleQty } from "@/lib/recipes/rescale";
import { timerDisplay } from "@/lib/recipes/timer";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { isConflictError, trpcErrorCode } from "@/lib/trpc-errors";
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
 *
 * **Both writes declare `networkMode: "always"`.** `dish.*` is deliberately
 * not in the IndexedDB offline queue (which persists `cart.*` only), so with
 * the default `"online"` mode an archive tapped offline would *pause* before
 * its `mutationFn` ever ran — `onSettled` would never fire, the confirm
 * button would read «Убираем…» forever, and the write would be lost the
 * moment the app was killed. Failing fast and saying «нет сети» is the honest
 * behaviour for a mutation nobody is replaying later.
 *
 * **Focus is moved deliberately in the two places this screen unmounts the
 * element that has it**: when the sheet swaps its menu for the confirmation
 * (the menu row that was activated disappears while `BottomSheet` stays
 * mounted, so its own focus effect cannot re-run), and after «Вернуть»
 * succeeds and the banner holding it is replaced. Both follow the rescue
 * shape `revision-mode.tsx` and `cart-screen.tsx` already use.
 */
export function DishScreen({ dishId }: { dishId: string }) {
  const t = useTranslations("dish");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  /**
   * The screen's one announcement slot. `visible` separates the two things
   * that use it: a «скоро» tap has nothing else on screen to show for itself,
   * so it needs visible copy; an archive already has the banner saying so, and
   * repeating it at the bottom of the page would be noise for everyone who can
   * see the banner — but it still has to be *spoken*, because a live region
   * that mounts together with its text is not reliably announced.
   */
  const [hint, setHint] = useState<{
    text: string;
    seq: number;
    visible: boolean;
  } | null>(null);
  const hintSeq = useRef(0);
  /** Synchronous mutex — render state lands a re-render too late for a double tap. */
  const pendingRef = useRef(false);
  const sheetOpener = useSheetOpener();
  const online = useIsOnline();

  /** The «Отмена» button of the confirmation view; see `C1` in the effect below. */
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  /** The «…» button — where focus lands after «Вернуть» unmounts the banner. */
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterUndoRef = useRef(false);

  const dishFilter = trpc.dish.get.queryFilter({ id: dishId });
  const dishKey = trpc.dish.get.queryKey({ id: dishId });
  const dish = useQuery(trpc.dish.get.queryOptions({ id: dishId }));

  function invalidateDish() {
    void queryClient.invalidateQueries(dishFilter);
    void queryClient.invalidateQueries(trpc.dish.list.queryFilter());
    void queryClient.invalidateQueries(trpc.dish.listArchived.queryFilter());
  }

  /**
   * Applies the write's own answer to the cached dish before the refetch
   * lands, so the banner (or its absence) is immediate and — the part that
   * matters — `detail.version` is already the bumped token. Without it a
   * second tap inside the refetch window would re-send the version the server
   * has just spent and come back `CONFLICT` for a write that succeeded.
   *
   * `archivedAt` is only ever read as "is it null", so the placeholder
   * `Date` never reaches the screen as a value; the invalidation right after
   * replaces it with the server's own.
   */
  function applyArchivedAt(version: number, archivedAt: Date | null) {
    queryClient.setQueryData(dishKey, (previous) =>
      previous === undefined ? previous : { ...previous, archivedAt, version },
    );
  }

  /**
   * A stale `expectedVersion` is not «попробуй ещё раз»: retrying re-sends the
   * same token and fails identically for as long as the screen keeps showing
   * the superseded row. The honest move is to refresh what is on screen and
   * say so — after which the banner (or its absence) already reflects whatever
   * the partner did, and there may be nothing left to retry.
   *
   * **Awaited, and that is the point.** `onSettled` releases the mutex, and
   * TanStack awaits a promise returned from `onError` before running it — so
   * awaiting the refetch here is what stops an immediate second tap from
   * sending the very same stale token again. The success paths need no such
   * await: they seed the cache with the version the server just returned.
   */
  async function refreshAfterConflict() {
    await Promise.all([
      queryClient.invalidateQueries(dishFilter),
      queryClient.invalidateQueries(trpc.dish.list.queryFilter()),
      queryClient.invalidateQueries(trpc.dish.listArchived.queryFilter()),
    ]);
  }

  const archive = useMutation(
    trpc.dish.archive.mutationOptions({
      // See the screen's doc comment: dish writes are never queued offline,
      // so they must fail fast rather than park unattended.
      networkMode: "always",
      onSuccess: (result) => {
        setSheet(null);
        setBannerError(null);
        applyArchivedAt(result.version, new Date());
        announce(t("archivedAnnounce"));
        invalidateDish();
      },
      onError: async (error) => {
        if (isConflictError(error)) {
          // The refreshed card is the answer; leaving the scrim up would hide
          // the very thing the user needs to look at.
          setSheet(null);
          setBannerError(t("conflict"));
          await refreshAfterConflict();
          return;
        }
        setSheetError(t("archiveError"));
      },
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  const unarchive = useMutation(
    trpc.dish.unarchive.mutationOptions({
      networkMode: "always",
      onSuccess: (result) => {
        setBannerError(null);
        // The banner — and the «Вернуть» inside it that still holds focus —
        // is about to unmount.
        restoreFocusAfterUndoRef.current = true;
        applyArchivedAt(result.version, null);
        announce(t("undoDone"));
        invalidateDish();
      },
      onError: async (error) => {
        if (isConflictError(error)) {
          setBannerError(t("conflict"));
          await refreshAfterConflict();
          return;
        }
        setBannerError(t("undoError"));
      },
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  /**
   * Claims focus when the sheet swaps its menu for the confirmation.
   *
   * `BottomSheet` claims focus once, in an effect keyed on `open` and the
   * (stable) opener ref — neither of which changes here — so when the menu
   * `<ul>` holding the activated «В архив» unmounts, focus falls to `<body>`
   * and the destructive confirmation is never announced. «Отмена» rather than
   * «Убрать»: pre-focusing the destructive choice is how a stray Enter
   * archives a dish nobody meant to archive.
   */
  useEffect(() => {
    if (sheet === "confirm") {
      confirmCancelRef.current?.focus();
    }
  }, [sheet]);

  /**
   * Rescues focus after a successful «Вернуть» — the same shape
   * `cart-screen.tsx` uses, and for the same reason: the button that was
   * activated is `aria-disabled` rather than `disabled`, so it still holds
   * focus at the moment its banner unmounts, and a browser drops that to
   * `<body>` rather than picking a neighbour.
   *
   * Keyed on `dish.data`, whose identity changes on every refetch (superjson
   * mints fresh `Date`s), with the ref guard and the `activeElement` check
   * keeping it a rescue and never a steal.
   */
  useEffect(() => {
    if (!restoreFocusAfterUndoRef.current) {
      return;
    }
    restoreFocusAfterUndoRef.current = false;

    const active = document.activeElement;
    if (active === null || active === document.body) {
      moreButtonRef.current?.focus();
    }
  }, [dish.data]);

  /** Spoken only — the screen already shows what happened. */
  function announce(text: string) {
    hintSeq.current += 1;
    setHint({ text, seq: hintSeq.current, visible: false });
  }

  /** Spoken *and* shown — there is nothing else to see. */
  function announceSoon(action: string) {
    hintSeq.current += 1;
    setHint({
      text: t("soonHint", { action }),
      seq: hintSeq.current,
      visible: true,
    });
  }

  function confirmArchive(version: number) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setSheetError(null);
    setBannerError(null);
    archive.mutate({ id: dishId, expectedVersion: version });
  }

  function undoArchive(version: number) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setBannerError(null);
    unarchive.mutate({ id: dishId, expectedVersion: version });
  }

  if (dish.isPending) {
    return <DishSkeleton label={t("loading")} />;
  }

  // Only when there is nothing cached to show. `status` flips to `"error"` on
  // a *background* failure while `data` is retained, so an unconditional
  // early return would replace an archived dish — banner, «Вернуть» and all —
  // with a load-failure page the moment a refetch blipped. Cart, pantry and
  // S6 all render that case additively; the strip below does the same here.
  if (dish.isError && dish.data === undefined) {
    // A dish this household does not have is not a retryable failure — the
    // only useful action is going back, so the screen does not offer a button
    // that would fail identically every time it is pressed.
    const missing = trpcErrorCode(dish.error) === "NOT_FOUND";

    return (
      <section className={styles.screen}>
        <BackLink label={t("back")} />
        <div className={styles.error} role="alert">
          <p>{missing ? t("notFound") : t("loadFailed")}</p>
          {missing ? null : (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => void dish.refetch()}
            >
              {t("retry")}
            </button>
          )}
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
          ref={moreButtonRef}
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

      {/* A background refetch failure leaves the cached dish on screen and
          says so here, rather than replacing the page (and its undo) with a
          full-screen error — the same additive treatment S3, S5 and S6 use. */}
      {dish.isError ? (
        <p className={styles.error} role="alert">
          {t("loadFailed")}
        </p>
      ) : null}

      {/* Outside the archived block on purpose: an archive refused with
          CONFLICT leaves the dish *unarchived*, so a slot that only existed
          alongside the banner would swallow the one message explaining why
          nothing happened. Rendered near the top, in the error treatment —
          not at the far bottom of the page in the muted «скоро» hint style. */}
      {bannerError === null ? null : (
        <p className={styles.error} role="alert">
          {bannerError}
        </p>
      )}

      {detail.archivedAt === null ? null : (
        <>
          {/* Deliberately not `role="status"`: a live region that mounts
              together with its text is not reliably announced (the rule
              cart-screen.tsx and pantry-screen.tsx both document), and the
              archive is announced through the screen's permanent region
              instead. */}
          <div className={styles.archivedBanner}>
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
          {online ? null : <p className={styles.offline}>{t("offline")}</p>}
        </>
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
          {t(SOURCE_MESSAGE[detail.sourceType])}
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
          {detail.steps.map((step, index) => {
            const timer = timerDisplay(step.timerSec, step.timerMaxSec);

            return (
              <li key={step.id} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {index + 1}
                </span>
                <div className={styles.stepBody}>
                  <p className={styles.stepText}>{step.text}</p>
                  {timer === null ? null : (
                    <span className={styles.timer}>{timerText(timer, t)}</span>
                  )}
                </div>
              </li>
            );
          })}
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
        {hint === null || !hint.visible ? null : (
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
                ref={confirmCancelRef}
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
            {/* Told before the tap, not after: with `networkMode: "always"`
                the write would fail immediately, and «нет сети» explains that
                better than a generic failure would. Inside the sheet's own
                aria-modal subtree, like every other message here. */}
            {online ? null : (
              <p className={styles.offline}>{t("offline")}</p>
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

/**
 * The stored enum → its message key, spelled out rather than derived from the
 * value. A computed `t(`source${...}`)` would compile, would be invisible to a
 * grep for the key, and would break silently the day a fifth source is added.
 */
const SOURCE_MESSAGE = {
  photo: "sourcePhoto",
  url: "sourceUrl",
  text: "sourceText",
  manual: "sourceManual",
} as const satisfies Record<DishDetailOutput["sourceType"], string>;

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

/**
 * «на 8 порций» / «на 8 печений» over the ingredient list (DESIGN_BRIEF S7).
 *
 * The count is `portionsBase` whether or not the source stated a range — the
 * quantities below are stated for that number — so the only question is
 * whether the recipe gave its own yield noun. Branching on the *range* here
 * instead is what made S7 say «7–8 печений» two lines above «на 8 порций».
 */
function ingredientsForText(detail: DishDetailOutput, t: Translate): string {
  const unit = ingredientsYieldUnit(detail.recipe);

  return unit === null
    ? t("ingredientsFor", { count: detail.recipe.portionsBase })
    : t("ingredientsForUnit", { count: detail.recipe.portionsBase, unit });
}

/**
 * «9–11 мин» / «30 сек» from two integers, never from a stored Russian label.
 *
 * The arithmetic — including the rule that a sub-minute countdown stays in
 * seconds rather than rounding to «0 мин» — is `timerDisplay`
 * (`src/lib/recipes/timer.ts`, pure and tested, and what task 4.7's overlay
 * will render its own countdown from). This function only picks the message.
 */
function timerText(
  display: NonNullable<ReturnType<typeof timerDisplay>>,
  t: Translate,
): string {
  if (display.kind === "single") {
    return display.unit === "sec"
      ? t("timerSeconds", { seconds: display.value })
      : t("timer", { minutes: display.value });
  }

  return display.unit === "sec"
    ? t("timerSecondsRange", { from: display.from, to: display.to })
    : t("timerRange", { from: display.from, to: display.to });
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
          optimization budget, fixed ratio so the page does not reflow. No
          `loading="lazy"` here, unlike the grid tile: this is the first thing
          on the screen, so deferring it would only delay the hero image. */}
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
