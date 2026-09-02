"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

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
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);
  const sourceOpener = useSheetOpener();

  const dishes = useQuery(trpc.dish.list.queryOptions());

  const items = useMemo(() => dishes.data ?? [], [dishes.data]);
  const tags = useMemo(() => collectTags(items), [items]);
  const visible = useMemo(
    () => filterDishes(items, { query, tag }),
    [items, query, tag],
  );

  const hasList = dishes.data !== undefined;
  const isEmpty = hasList && items.length === 0;
  const nothingFound = hasList && items.length > 0 && visible.length === 0;

  /**
   * The empty state's «📷 С фото» leads to `/dishes/import?src=photo`, which
   * task 4.3 builds. Until then it says so out loud rather than linking to a
   * 404 — `main` deploys to production on every merge.
   */
  function announceSoon(action: string) {
    hintSeq.current += 1;
    setHint({ text: t("soonHint", { action }), seq: hintSeq.current });
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
                className={cx(styles.tag, tag === null && styles.tagActive)}
                aria-pressed={tag === null}
                onClick={() => setTag(null)}
              >
                {t("tagAll")}
              </button>
              {tags.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cx(styles.tag, tag === value && styles.tagActive)}
                  aria-pressed={tag === value}
                  onClick={() => setTag(tag === value ? null : value)}
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
          {hint === null ? null : (
            <p className={styles.hint} aria-hidden="true">
              {hint.text}
            </p>
          )}
        </div>
      ) : null}

      {nothingFound ? (
        <p className={styles.nothingFound}>{t("nothingFound")}</p>
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
          S3/S5 for why both halves matter. The visible copy of the same text
          renders next to the control that produced it, inside the empty state
          above; this one exists only for assistive tech. */}
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
