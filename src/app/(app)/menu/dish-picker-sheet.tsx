"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { BottomSheet } from "@/components/bottom-sheet";
import { cx } from "@/lib/cx";
import { filterDishes } from "@/lib/recipes/filter-dishes";
import { portionsDisplay } from "@/lib/recipes/portions";
import { useIsOnline } from "@/lib/sync/use-is-online";
import type { DishListItemOutput } from "@/server/api/routers/dish";
import { useTRPC } from "@/trpc/client";

import styles from "./dish-picker-sheet.module.css";

/**
 * How long the filter has to settle before «ничего не нашлось» is announced —
 * the same delay and the same reason S6 uses: a live region firing per
 * character would read a running commentary over the typing.
 */
const ANNOUNCE_DELAY_MS = 500;

/**
 * The «+ Блюдо» picker (DESIGN_BRIEF S10) — a bottom sheet over the library,
 * one tap per dish into this week's pool.
 *
 * **It reads `dish.list`, the same single cache entry S6 renders**, already
 * prefetched by `/menu/page.tsx`, and filters it client-side with
 * `filterDishes` — S6's own pure function. So the sheet opens with its list
 * in it, no keystroke costs a request, and the picker keeps working on a dead
 * connection right up to the tap that writes. No tag chips: a second filter
 * axis inside a sheet is chrome for a search over a household's tens of
 * dishes.
 *
 * **The sheet stays open after every pick** (VISION §4 scenario А is «вечером
 * выбираем в пул 4–5 блюд»): closing per pick would cost five open/close
 * cycles and five focus restorations. The picked row flips to «✓ в меню» and
 * goes `aria-disabled` **in place** — never `disabled`, never removed — so
 * the focus sitting on it survives the change.
 *
 * **All feedback renders inside the sheet's own `aria-modal` subtree.** A
 * fixed page-level region is behind the scrim and pruned from the
 * accessibility tree, which is the repo's own documented bug class; the
 * region below is mounted for the sheet's life with a `seq`-keyed child so
 * two identical answers still announce twice.
 *
 * The default portions is the recipe's own `portionsBase`, not a number the
 * sheet asks for: it is what the card would show anyway, and asking for a
 * count before the dish is even in the pool is a step nobody needs. One tap
 * on the card changes it.
 */
export function DishPickerSheet({
  open,
  onClose,
  restoreFocusTo,
  inMenuDishIds,
}: {
  open: boolean;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  /** Dish ids already in this week's pool, from `menu.current`. */
  inMenuDishIds: ReadonlySet<string>;
}) {
  const t = useTranslations("menu");
  // The portions label goes through S7's own four `dish.portions*` messages,
  // so a dish's yield is worded identically wherever it is read.
  const td = useTranslations("dish");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const online = useIsOnline();

  const [query, setQuery] = useState("");
  /**
   * The sheet's one feedback line. `kind` separates its two writers: an
   * add outcome stands until the next one, while «ничего не нашлось» has to
   * be withdrawn the moment the filter matches again — otherwise the region
   * keeps contradicting the list under it (the bug S6 documents against its
   * own hint slot).
   */
  const [feedback, setFeedback] = useState<{
    text: string;
    seq: number;
    kind: "result" | "empty";
  } | null>(null);
  const feedbackSeq = useRef(0);
  /**
   * Dishes this sheet has put in the pool since it opened.
   *
   * The row has to flip to «✓ в меню» on the tap, not when the invalidated
   * `menu.current` comes back — a row that stays tappable for a round trip is
   * a row that gets tapped twice. Unioned with the server's own answer below,
   * and thrown away when the sheet closes.
   */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** Synchronous mutex — render state lands a re-render too late for a double tap. */
  const pendingRef = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const dishes = useQuery(trpc.dish.list.queryOptions());
  const items = useMemo(() => dishes.data ?? [], [dishes.data]);
  const visible = useMemo(
    () => filterDishes(items, { query, tag: null }),
    [items, query],
  );

  const hasList = dishes.data !== undefined;
  const isEmpty = hasList && items.length === 0;
  const nothingFound = hasList && items.length > 0 && visible.length === 0;

  function announce(text: string, kind: "result" | "empty" = "result") {
    feedbackSeq.current += 1;
    setFeedback({ text, seq: feedbackSeq.current, kind });
  }

  /** A fresh open starts with a clean search, no stale answer and no locks. */
  useEffect(() => {
    if (open) {
      return;
    }

    setQuery("");
    setFeedback(null);
    setPicked(new Set());
    setPendingId(null);
    pendingRef.current = false;
  }, [open]);

  const nothingFoundText = t("pickerNothingFound");
  const nothingFoundTextRef = useRef(nothingFoundText);
  useEffect(() => {
    nothingFoundTextRef.current = nothingFoundText;
  });

  /**
   * Filtering to nothing is a result, and it is announced on the *outcome*
   * rather than on the query — so a run of keystrokes that stays empty
   * announces once. The visible paragraph below is `aria-hidden`, because the
   * region already carries the same sentence.
   */
  useEffect(() => {
    if (!nothingFound) {
      // Withdraw only our own sentence: an «X — в меню недели» from a pick a
      // moment ago is still true and must survive the next keystroke.
      setFeedback((current) => (current?.kind === "empty" ? null : current));
      return;
    }

    const timer = setTimeout(() => {
      announce(nothingFoundTextRef.current, "empty");
    }, ANNOUNCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [nothingFound]);

  const addDish = useMutation(
    trpc.menu.addDish.mutationOptions({
      // `menu.*` is not in the IndexedDB offline queue, so a write dispatched
      // offline must fail rather than pause: a paused mutation never settles,
      // and this sheet's mutex would stay locked for the whole outage.
      networkMode: "always",
      onSuccess: (result) => {
        setPicked((current) => new Set(current).add(result.item.dishId));
        announce(
          result.outcome === "added"
            ? t("pickerAdded", { title: result.item.title })
            : t("pickerAlready", { title: result.item.title }),
        );
        void queryClient.invalidateQueries(trpc.menu.current.queryFilter());
      },
      onError: () => {
        announce(t("pickerError"));
      },
      onSettled: () => {
        pendingRef.current = false;
        setPendingId(null);
      },
    }),
  );

  function pick(dish: DishListItemOutput) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPendingId(dish.id);
    addDish.mutate({ dishId: dish.id, portions: dish.portionsBase });
  }

  /** «30 мин · 8 порций» — the two parts a picker row needs to decide with. */
  function rowMeta(dish: DishListItemOutput): string {
    const display = portionsDisplay(dish);
    const portions =
      display.kind === "range"
        ? display.unit === null
          ? td("portionsRange", { from: display.from, to: display.to })
          : td("portionsRangeUnit", {
              from: display.from,
              to: display.to,
              unit: display.unit,
            })
        : display.unit === null
          ? td("portions", { count: display.count })
          : td("portionsUnit", { count: display.count, unit: display.unit });

    return dish.totalTimeMin === null
      ? portions
      : `${t("cardTime", { minutes: dish.totalTimeMin })} · ${portions}`;
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("pickerTitle")}
      closeLabel={common("close")}
      restoreFocusTo={restoreFocusTo}
    >
      <div className={styles.body}>
        {isEmpty ? null : (
          <>
            <label className={styles.searchLabel} htmlFor="menu-dish-search">
              {t("pickerSearchLabel")}
            </label>
            <input
              id="menu-dish-search"
              type="search"
              className={styles.search}
              value={query}
              placeholder={t("pickerSearchPlaceholder")}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        )}

        {dishes.isPending ? (
          <p className={styles.state}>{t("pickerLoading")}</p>
        ) : null}

        {dishes.isError && dishes.data === undefined ? (
          <p className={styles.error} role="alert">
            {t("pickerLoadFailed")}
          </p>
        ) : null}

        {isEmpty ? (
          <div className={styles.empty}>
            <p className={styles.state}>{t("pickerEmpty")}</p>
            <Link className={styles.emptyLink} href="/dishes">
              {t("pickerEmptyLink")}
            </Link>
          </div>
        ) : null}

        {/* `aria-hidden`: the same sentence is already in the accessibility
            tree through the region at the bottom of this sheet. */}
        {nothingFound ? (
          <p className={styles.state} aria-hidden="true">
            {t("pickerNothingFound")}
          </p>
        ) : null}

        {visible.length === 0 ? null : (
          <ul className={styles.list}>
            {visible.map((dish) => {
              const inMenu = inMenuDishIds.has(dish.id) || picked.has(dish.id);
              const pending = pendingId === dish.id;

              return (
                <li key={dish.id}>
                  <button
                    type="button"
                    className={cx(styles.row, inMenu && styles.rowInMenu)}
                    // `aria-disabled` in place, never `disabled` and never
                    // removed: the focus sitting on the row that was just
                    // tapped has to survive the flip.
                    aria-disabled={inMenu || undefined}
                    aria-label={
                      inMenu
                        ? t("pickerInMenuAria", { title: dish.title })
                        : t("pickerAddAria", { title: dish.title })
                    }
                    onClick={inMenu ? undefined : () => pick(dish)}
                  >
                    <span className={styles.thumb} aria-hidden="true">
                      {dish.photoUrl === null ? (
                        "🍽"
                      ) : (
                        /* Arbitrary remote hosts, no optimization budget —
                           `DishCard` spells out the same reasoning. */
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className={styles.thumbPhoto}
                          src={dish.photoUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                        />
                      )}
                    </span>
                    <span className={styles.rowBody}>
                      <span className={styles.rowTitle}>{dish.title}</span>
                      <span className={styles.rowMeta}>{rowMeta(dish)}</span>
                    </span>
                    <span className={styles.rowMark} aria-hidden="true">
                      {inMenu
                        ? t("pickerInMenu")
                        : pending
                          ? t("pickerAdding")
                          : "+"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* DESIGN_BRIEF S10 offers this beside the library; phase 6 makes it
            real. `main` deploys on every merge, so an honest «скоро» beats a
            chip that navigates nowhere. */}
        <button
          type="button"
          className={styles.assistantRow}
          aria-disabled="true"
          onClick={() =>
            announce(t("soonHint", { action: t("pickerAssistant") }))
          }
        >
          {t("pickerAssistant")}
        </button>

        {online ? null : <p className={styles.offline}>{t("offline")}</p>}

        {/* Inside the sheet's `aria-modal` subtree, mounted for its whole
            life, with a keyed child so two identical answers announce twice. */}
        <p className={styles.srOnly} role="status">
          <span key={feedback?.seq ?? "empty"}>{feedback?.text ?? ""}</span>
        </p>
        {/* The `empty` kind is deliberately not shown here: it is already on
            screen as the paragraph above, and rendering it twice would put
            «ничего не нашлось» in two places at once. */}
        {feedback === null || feedback.kind === "empty" ? null : (
          <p className={styles.feedback} aria-hidden="true">
            {feedback.text}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
