"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { DishCard } from "@/components/dish-card";
import { useSheetOpener } from "@/components/use-sheet-opener";
import { cx } from "@/lib/cx";
import { collectTags, filterDishes } from "@/lib/recipes/filter-dishes";
import { portionsDisplay } from "@/lib/recipes/portions";
import type { DishListItemOutput } from "@/server/api/routers/dish";
import { useTRPC } from "@/trpc/client";

import { DishSourceSheet } from "./dish-source-sheet";
import styles from "./dish-library-screen.module.css";

/** Enough tiles to fill the first screen while the real ones load. */
const SKELETON_TILES = 4;

/**
 * How long the filter has to settle before "nothing matched" is announced.
 *
 * The grid itself re-filters on every keystroke — that is the point of
 * client-side filtering — but a live region that fired per character would
 * read a running commentary over the typing. Long enough to cover a pause,
 * short enough that it still feels like an answer.
 */
const ANNOUNCE_DELAY_MS = 500;

/**
 * S6 «Блюда» (DESIGN_BRIEF S6, VISION §3.3) — the household's recipe library
 * as a two-column grid with a search box and a row of tag chips.
 *
 * **Search and tag filtering never leave the browser.** `dish.list` takes no
 * input and returns the whole library, so one cache entry serves the screen:
 * every keystroke re-filters an array (`filterDishes`, pure and tested), with
 * no debounce, no request per character, and no empty grid while a query is
 * in flight. It also means the library keeps working with a dead connection.
 * The documented threshold for revisiting this is ~200 dishes.
 *
 * **No `cartSyncQueryOptions` here, deliberately.** That preset's polling and
 * focus-refetch exist because two people race over one shopping list at the
 * shelf; a recipe library is not that, and a 45-second poll would burn
 * requests for nobody. The default `staleTime` applies, and `dish.get`/`list`
 * are invalidated by the writes that change them.
 *
 * Skeleton tiles on first load rather than a spinner (DESIGN_BRIEF §6), and
 * the empty state offers the one action that matters — «📷 С фото».
 */
export function DishLibraryScreen() {
  const t = useTranslations("dishes");
  const trpc = useTRPC();

  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  /**
   * The screen's announcement slot, and — since task 4.4 gave the source
   * sheet's «скоро» rows real links — its one writer: «ничего не нашлось».
   *
   * It is announced but not rendered here, because it is already on screen as
   * its own paragraph; the region exists because a live region that mounts
   * *together with* its text is not reliably announced. (It used to carry a
   * `visible` flag separating that writer from the sheet's «скоро» tap, which
   * had nothing else on screen to show for itself. The tap is gone, so the
   * flag was a branch that could no longer be reached.)
   */
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);
  const sourceOpener = useSheetOpener();

  const dishes = useQuery(trpc.dish.list.queryOptions());

  const items = useMemo(() => dishes.data ?? [], [dishes.data]);
  const tags = useMemo(() => collectTags(items), [items]);

  /**
   * The tag actually applied — the selection reconciled against the tags the
   * library still has.
   *
   * The chip row (including the «все» reset) only renders while some tag
   * exists, so a background refetch that removes the library's *last* tag —
   * a partner retagging or archiving the only tagged dish — would otherwise
   * leave a selection applied with no control left to clear it: the grid
   * filters to empty and «сними фильтр» names a chip that is not there.
   * Deriving it is what the render reads, so the chip row and the grid always
   * agree within the very frame the tag disappears — an effect on its own
   * would flash one filtered-to-empty frame first.
   */
  const activeTag = tag !== null && tags.includes(tag) ? tag : null;

  /**
   * …and then the state is narrowed to match, a tick later.
   *
   * Masking alone is not enough: the selection would still be sitting in
   * state, so a tag that leaves the library and comes back on a later refetch
   * (a partner archiving and restoring the last dish carrying it) would
   * silently re-apply a filter nobody re-selected — the chip reappearing
   * already pressed. Because `activeTag` drives the render, this runs after
   * the frame that already showed the filter cleared, so it costs no flash.
   */
  useEffect(() => {
    if (tag !== null && !tags.includes(tag)) {
      setTag(null);
    }
  }, [tag, tags]);

  const visible = useMemo(
    () => filterDishes(items, { query, tag: activeTag }),
    [items, query, activeTag],
  );

  /**
   * Filtering the grid to nothing is a result, and a screen reader has to be
   * told it — the visible «Ничего не нашлось» is a paragraph that mounts with
   * its own text, which is precisely the pattern this codebase documents as
   * unreliable (cart-screen.tsx). It goes through the permanently mounted
   * region below instead.
   *
   * The effect depends on the *outcome*, not on the query, so a run of
   * keystrokes that stays empty announces once; going back to results and
   * empty again announces again, which is the honest reading of what
   * happened. The message text is read from a ref so re-rendering never
   * restarts the timer.
   */
  const nothingFoundText = t("nothingFound");
  const nothingFoundTextRef = useRef(nothingFoundText);
  useEffect(() => {
    nothingFoundTextRef.current = nothingFoundText;
  });

  const hasList = dishes.data !== undefined;
  const isEmpty = hasList && items.length === 0;
  const nothingFound = hasList && items.length > 0 && visible.length === 0;

  useEffect(() => {
    if (!nothingFound) {
      // The region keeps whatever it last held, so a filter that starts
      // matching again would otherwise leave «Ничего не нашлось» sitting in
      // the accessibility tree, contradicting the grid.
      setHint(null);
      return;
    }

    const timer = setTimeout(() => {
      hintSeq.current += 1;
      setHint({ text: nothingFoundTextRef.current, seq: hintSeq.current });
    }, ANNOUNCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [nothingFound]);

  /**
   * «30 мин · 8 порций · выпечка, духовка» (DESIGN_BRIEF §3): whichever of
   * the three parts this dish actually has, joined by the ledger's own
   * separator. A dish with no time and no tags simply gets a shorter line
   * instead of «— · — · —».
   */
  function cardMeta(dish: DishListItemOutput): string {
    const parts: string[] = [];

    if (dish.totalTimeMin !== null) {
      parts.push(t("cardTime", { minutes: dish.totalTimeMin }));
    }

    parts.push(portionsLabel(dish));

    if (dish.tags.length > 0) {
      parts.push(dish.tags.join(", "));
    }

    return parts.join(" · ");
  }

  /**
   * «8 порций» · «7–8 печений». The branch itself is `portionsDisplay`
   * (pure, tested) — the same function S7 uses, so a card and the card it
   * opens can never disagree about what a dish yields; only the message keys
   * differ, because the two screens word it differently.
   */
  function portionsLabel(dish: DishListItemOutput): string {
    const display = portionsDisplay(dish);

    if (display.kind === "range") {
      return display.unit === null
        ? t("cardPortionsRange", { from: display.from, to: display.to })
        : t("cardPortionsRangeUnit", {
            from: display.from,
            to: display.to,
            unit: display.unit,
          });
    }

    return display.unit === null
      ? t("cardPortions", { count: display.count })
      : t("cardPortionsUnit", { count: display.count, unit: display.unit });
  }

  return (
    <section className={styles.screen}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t("title")}</h1>
        {hasList ? (
          <span className={styles.count}>
            {t("count", { count: items.length })}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.addButton}
          aria-label={t("addAria")}
          onClick={(event) => {
            sourceOpener.captureOpener(event.currentTarget);
            setSourceOpen(true);
          }}
        >
          {t("add")}
        </button>
      </div>

      {isEmpty ? null : (
        <>
          <label className={styles.searchLabel} htmlFor="dish-search">
            {t("searchLabel")}
          </label>
          <input
            id="dish-search"
            type="search"
            className={styles.search}
            value={query}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />

          {tags.length === 0 ? null : (
            <div
              className={styles.tags}
              role="group"
              aria-label={t("tagsLabel")}
            >
              <button
                type="button"
                className={cx(
                  styles.tag,
                  activeTag === null && styles.tagActive,
                )}
                aria-pressed={activeTag === null}
                onClick={() => setTag(null)}
              >
                {t("tagAll")}
              </button>
              {tags.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cx(
                    styles.tag,
                    activeTag === value && styles.tagActive,
                  )}
                  aria-pressed={activeTag === value}
                  onClick={() => setTag(activeTag === value ? null : value)}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {dishes.isError ? (
        <div className={styles.error} role="alert">
          <p>{t("loadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void dishes.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : null}

      {dishes.isPending ? <LibrarySkeleton label={t("loading")} /> : null}

      {isEmpty ? (
        <div className={styles.empty}>
          <div className={styles.emptyMark} aria-hidden="true">
            🍽
          </div>
          <p className={styles.emptyText}>{t("empty")}</p>
          {/* The main road out of an empty library (VISION scenario Б): a
              screenshot, not a form. `?src=photo` lands on S8.1 with the
              picker already focused. */}
          <Link className={styles.emptyAction} href="/dishes/import?src=photo">
            {t("emptyAction")}
          </Link>
          <Link className={styles.emptySecondary} href="/dishes/new">
            {t("emptyManual")}
          </Link>
        </div>
      ) : null}

      {/* `aria-hidden`, like every other visible twin of a live region in this
          app: the sentence is already in the accessibility tree via the status
          region below, and a second copy is read twice while browsing. */}
      {nothingFound ? (
        <p className={styles.nothingFound} aria-hidden="true">
          {t("nothingFound")}
        </p>
      ) : null}

      {visible.length === 0 ? null : (
        <div className={styles.grid}>
          {visible.map((dish) => (
            <DishCard
              key={dish.id}
              href={`/dishes/${dish.id}`}
              title={dish.title}
              photoUrl={dish.photoUrl}
              photoAlt={t("cardPhotoAlt", { title: dish.title })}
              meta={cardMeta(dish)}
              needsReviewLabel={
                dish.needsReviewCount > 0
                  ? t("cardNeedsReview", { count: dish.needsReviewCount })
                  : null
              }
            />
          ))}
        </div>
      )}

      {/* Permanently mounted, keyed child — see S3/S5 for why both halves
          matter. This node is for assistive tech only: its one sentence is
          already on screen as the paragraph above, and rendering it twice
          would have it read twice while browsing. */}
      <p className={styles.srOnly} role="status">
        <span key={hint?.seq ?? "empty"}>{hint?.text ?? ""}</span>
      </p>

      <DishSourceSheet
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        restoreFocusTo={sourceOpener.restoreFocusTo}
      />
    </section>
  );
}

export function LibrarySkeleton({ label }: { label: string }) {
  return (
    <div className={styles.grid} role="status" aria-label={label}>
      {Array.from({ length: SKELETON_TILES }, (_, index) => (
        <div key={index} className={styles.skeletonCard}>
          <div className={styles.skeletonFrame} />
          <div className={styles.skeletonBody}>
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonMeta} />
          </div>
        </div>
      ))}
    </div>
  );
}
