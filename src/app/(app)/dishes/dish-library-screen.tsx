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
   * The screen's one announcement slot. `visible` separates its two writers,
   * the same split `dish-screen.tsx` makes: a «скоро» tap has nothing else on
   * screen to show for itself and needs visible copy, while «ничего не
   * нашлось» is already on screen as a paragraph and only needs *speaking* —
   * a live region that mounts together with its text is not reliably
   * announced.
   */
  const [hint, setHint] = useState<{
    text: string;
    seq: number;
    visible: boolean;
  } | null>(null);
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
      // the accessibility tree, contradicting the grid. Matched on the text
      // rather than cleared outright, so a «скоро» hint set in the meantime
      // survives.
      setHint((current) =>
        current?.text === nothingFoundTextRef.current ? null : current,
      );
      return;
    }

    const timer = setTimeout(() => {
      hintSeq.current += 1;
      setHint({
        text: nothingFoundTextRef.current,
        seq: hintSeq.current,
        visible: false,
      });
    }, ANNOUNCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [nothingFound]);

  /**
   * The empty state's «📷 С фото» leads to `/dishes/import?src=photo`, which
   * task 4.3 builds. Until then it says so out loud rather than linking to a
   * 404 — `main` deploys to production on every merge.
   */
  function announceSoon(action: string) {
    hintSeq.current += 1;
    setHint({
      text: t("soonHint", { action }),
      seq: hintSeq.current,
      visible: true,
    });
  }


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
          <span className={styles.count}>{t("count", { count: items.length })}</span>
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
                className={cx(styles.tag, activeTag === null && styles.tagActive)}
                aria-pressed={activeTag === null}
                onClick={() => setTag(null)}
              >
                {t("tagAll")}
              </button>
              {tags.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cx(styles.tag, activeTag === value && styles.tagActive)}
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
          <button
            type="button"
            className={styles.emptyAction}
            aria-disabled="true"
            onClick={() => announceSoon(t("sourcePhoto"))}
          >
            {t("emptyAction")}
          </button>
          {/* The one path out of the empty state that actually works today
              (task 4.2). Photo import is 4.3, so «📷 С фото» above still says
              «скоро» — and an empty library with no working action at all
              would be a dead end. */}
          <Link className={styles.emptySecondary} href="/dishes/new">
            {t("emptyManual")}
          </Link>
          {hint === null || !hint.visible ? null : (
            <p className={styles.hint} aria-hidden="true">
              {hint.text}
            </p>
          )}
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

      {/* Permanently mounted, keyed child — see `dish-source-sheet.tsx` and
          S3/S5 for why both halves matter. This node is for assistive tech
          only; whether the same text also appears on screen depends on the
          writer (`hint.visible`): a «скоро» tap renders it in the empty state
          above, an empty search result is already visible as its own
          paragraph. */}
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

function LibrarySkeleton({ label }: { label: string }) {
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
