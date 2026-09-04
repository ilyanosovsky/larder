"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { BottomSheet } from "@/components/bottom-sheet";
import { useSheetOpener } from "@/components/use-sheet-opener";
import { cx } from "@/lib/cx";
import { cardPortionsMessage } from "@/lib/menu/card-portions";
import { formatWeekRange, isBuiltInWeek } from "@/lib/menu/week-label";
import {
  removePantryRow,
  restorePantryRow,
  type PantryRemovalSnapshot,
} from "@/lib/pantry/optimistic-remove";
import { portionsRange } from "@/lib/recipes/rescale";
import { menuSyncQueryOptions } from "@/lib/sync/menu-sync-presets";
import { useChangedRows } from "@/lib/sync/use-changed-rows";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { useManualRefresh } from "@/lib/sync/use-manual-refresh";
import { trpcErrorCode } from "@/lib/trpc-errors";
import type { MenuItemOutput } from "@/server/api/routers/menu";
import { useTRPC } from "@/trpc/client";

import { BuildCartButton } from "./build-cart-button";
import { DishPickerSheet } from "./dish-picker-sheet";
import styles from "./menu-screen.module.css";
import { PastWeeksSection } from "./past-weeks-section";

/** Enough rows to fill the first screen while the real pool loads. */
const SKELETON_CARDS = 3;

/**
 * S10 «Меню на неделю» (DESIGN_BRIEF S10, VISION §3.4) — this week's pool of
 * dishes, with portions and a «приготовлено» mark, and no days attached.
 *
 * **The week is the server's answer** (`src/server/menu/week.ts`), which is
 * what makes the screen prefetchable and what stops two partners in two zones
 * from planning different weeks. The header renders it through
 * `formatWeekRange` — a formatted date is data, not copy, so it needs no ICU
 * message.
 *
 * **The card is local to this file, not `DishCard`.** That component is a
 * `Link` wrapping its whole tile, and this card holds three controls; bending
 * it polymorphic would be a drive-by refactor of a component two shipped
 * screens depend on. What *is* reused is the meta composition and the photo
 * fallback idea. The title is its own `<Link>`, so the pool is a way into S7.
 *
 * **Every write is optimistic, patched by id, and never debounced (D18).**
 * `menu.setPortions` and `menu.setCooked` are plain last-write-wins updates
 * on the server, so racing taps are safe and a trailing timer would only
 * reintroduce the repo's documented lost-write class. `onMutate` cancels
 * in-flight refetches before patching — otherwise one already on the wire
 * would land on top and visibly snap the number back — and patches the cached
 * item **by id**: `menu.current` rows carry `Date`s, superjson mints new ones
 * on every refetch, and structural sharing is defeated, so object identity is
 * never a handle on a row.
 *
 * **Every mutation declares `networkMode: "always"`.** The IndexedDB offline
 * queue persists `cart.*` only, so with the default `"online"` mode a menu
 * write tapped offline would *pause* before its `mutationFn` ran: `onSettled`
 * would never fire, the ± would sit mid-write forever and the write would die
 * with the tab. Failing fast, with the «нет связи» line above, is the honest
 * behaviour for a write nobody is replaying later.
 *
 * **A background load failure is additive, never an early return.** `status`
 * flips to `"error"` on a refetch while `data` is retained, and replacing a
 * menu somebody is editing with a failure page over one blipped request is
 * the bug S3, S5, S6 and S7 all render around.
 */
export function MenuScreen() {
  const t = useTranslations("menu");
  const common = useTranslations("common");
  const format = useFormatter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [pickerOpen, setPickerOpen] = useState(false);
  /** Which card's «…» sheet is open, by menu-item id. */
  const [sheetItemId, setSheetItemId] = useState<string | null>(null);
  /**
   * The screen's announcement slot. Mounted for the screen's whole life with
   * a `seq`-keyed child, so two identical messages still announce twice — a
   * region that mounts together with its text is not reliably announced.
   */
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);
  /**
   * Synchronous mutex for the one destructive action. Render state lands a
   * re-render too late for a double tap, and «Убрать» has no confirmation to
   * absorb the second one. The ± and the checkbox deliberately take no mutex:
   * one write per tap is the contract, and the server is last-write-wins.
   */
  const removePendingRef = useRef(false);
  /**
   * The portions value each card's last tap *asked for*, by item id.
   *
   * The ± control has no mutex — one write per tap is the contract — so the
   * only thing a second tap needs is the number the first one sent, and the
   * render cannot supply it: `onMutate` opens with an awaited `cancelQueries`,
   * so the optimistic patch (and the re-render that carries it) lands a few
   * milliseconds after `mutate()` returns. Two taps inside that window would
   * both read 4 off the rendered row and both send 5. A synchronous ref is the
   * repo's own answer to exactly this class; entries are dropped on settle, so
   * a failed write falls back to whatever the rolled-back row shows.
   */
  const askedPortionsRef = useRef(new Map<string, number>());
  const pickerOpener = useSheetOpener();
  const cardSheetOpener = useSheetOpener();
  const online = useIsOnline();

  /** «+ Блюдо» — where focus lands after a removed card unmounts. */
  const addButtonRef = useRef<HTMLButtonElement>(null);
  /** Armed by the removal that is about to unmount the card holding focus. */
  const rescueFocusRef = useRef(false);

  const menuFilter = trpc.menu.current.queryFilter();
  const menuKey = trpc.menu.current.queryKey();
  const menu = useQuery(
    trpc.menu.current.queryOptions(undefined, { ...menuSyncQueryOptions }),
  );
  const { refresh, isRefreshing } = useManualRefresh(menuFilter);

  const data = menu.data;
  const items = data?.items;
  // `data.items` is the array the query handed back, not a derived one — the
  // hook's own contract, and a fresh array per render would make it re-diff
  // on every render instead of only on an actual refetch.
  const { changedIds } = useChangedRows(items);

  const sheetItem = items?.find((row) => row.id === sheetItemId) ?? null;

  /**
   * Consumes the rescue armed by a removal, once the card has actually gone.
   *
   * Guarded on `document.activeElement`: the sheet's own close already
   * restores focus to the «…» button when the card survives, so this must
   * rescue focus that was genuinely lost and never steal it from somewhere
   * the user has since moved.
   */
  useEffect(() => {
    if (!rescueFocusRef.current) {
      return;
    }
    if (document.activeElement !== document.body) {
      return;
    }

    rescueFocusRef.current = false;
    addButtonRef.current?.focus();
  }, [items]);

  function announce(text: string) {
    hintSeq.current += 1;
    setHint({ text, seq: hintSeq.current });
  }

  /** Patches one cached row **by id**, if it is still there. */
  function patchItem(id: string, patch: Partial<MenuItemOutput>) {
    queryClient.setQueryData(menuKey, (current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.map((row) =>
              row.id === id ? { ...row, ...patch } : row,
            ),
          },
    );
  }

  /**
   * A `NOT_FOUND` means the card is not there any more — a partner removed
   * it. Retrying would fail identically forever, so the useful answer is to
   * refresh what is on screen and say so (the repo's «a stale answer
   * refreshes, it does not re-send» rule).
   */
  function isGone(error: unknown): boolean {
    return trpcErrorCode(error) === "NOT_FOUND";
  }

  const setPortions = useMutation(
    trpc.menu.setPortions.mutationOptions({
      networkMode: "always",
      onMutate: async (variables) => {
        await queryClient.cancelQueries(menuFilter);

        const previous = queryClient
          .getQueryData(menuKey)
          ?.items.find((row) => row.id === variables.id)?.portions;

        patchItem(variables.id, { portions: variables.portions });

        return { previous };
      },
      onError: (error, variables, context) => {
        // Per row, not a whole-list snapshot: nudging two cards in the same
        // second is ordinary, and a snapshot taken before the first tap knows
        // nothing about the second.
        if (context?.previous !== undefined) {
          patchItem(variables.id, { portions: context.previous });
        }
        announce(isGone(error) ? t("notFound") : t("portionsError"));
      },
      onSettled: (_data, _error, variables) => {
        askedPortionsRef.current.delete(variables.id);
        void queryClient.invalidateQueries(menuFilter);
      },
    }),
  );

  const setCooked = useMutation(
    trpc.menu.setCooked.mutationOptions({
      networkMode: "always",
      onMutate: async (variables) => {
        await queryClient.cancelQueries(menuFilter);

        const previous = queryClient
          .getQueryData(menuKey)
          ?.items.find((row) => row.id === variables.id)?.cookedAt;

        // The placeholder `Date` is only ever read as "is it null" — the
        // invalidate below replaces it with the server's own stamp.
        patchItem(variables.id, {
          cookedAt: variables.cooked ? new Date() : null,
        });

        return { previous };
      },
      onError: (error, variables, context) => {
        if (context?.previous !== undefined) {
          patchItem(variables.id, { cookedAt: context.previous });
        }
        announce(isGone(error) ? t("notFound") : t("cookedError"));
      },
      onSettled: () => {
        void queryClient.invalidateQueries(menuFilter);
      },
    }),
  );

  const removeDish = useMutation(
    trpc.menu.removeDish.mutationOptions({
      networkMode: "always",
      onMutate: async (variables) => {
        await queryClient.cancelQueries(menuFilter);

        let snapshot: PantryRemovalSnapshot<MenuItemOutput> | null = null;
        queryClient.setQueryData(menuKey, (current) => {
          if (current === undefined) {
            return current;
          }
          const removal = removePantryRow(current.items, variables.id);
          snapshot = removal.snapshot;
          return { ...current, items: removal.list };
        });

        return { snapshot };
      },
      /**
       * Puts back exactly the row that was taken out, at the index it came
       * from — and does nothing if a refetch has already restored it. A
       * removal-shaped rollback that is not idempotent leaves two rows
       * sharing one id (`restorePantryRow`'s own doc comment).
       *
       * The helpers are the pantry's, reused rather than copied: they are
       * generic over `{ id }` and this is the same problem — «Кончилось»
       * removes one row from a list optimistically too. Renaming them to
       * drop the `Pantry` in the name would be a refactor of a shipped
       * module, which this PR is not.
       */
      onError: (error, _variables, context) => {
        if (context?.snapshot) {
          const snapshot = context.snapshot;
          queryClient.setQueryData(menuKey, (current) =>
            current === undefined
              ? current
              : { ...current, items: restorePantryRow(current.items, snapshot) },
          );
        }
        announce(t("removeError"));
      },
      onSettled: () => {
        removePendingRef.current = false;
        void queryClient.invalidateQueries(menuFilter);
      },
    }),
  );

  function changePortions(item: MenuItemOutput, delta: number) {
    const bounds = portionsRange(item.portionsBase);
    const from = askedPortionsRef.current.get(item.id) ?? item.portions;
    const next = Math.min(bounds.max, Math.max(bounds.min, from + delta));

    if (next === from) {
      return;
    }

    askedPortionsRef.current.set(item.id, next);
    // One write per tap, no debounce: the server is last-write-wins, so a run
    // of taps is a run of writes and none of them can be lost by a timer that
    // never fired.
    setPortions.mutate({ id: item.id, portions: next });
  }

  function confirmRemove(item: MenuItemOutput) {
    if (removePendingRef.current) {
      return;
    }
    removePendingRef.current = true;
    setSheetItemId(null);
    // The card — and the «…» button inside the sheet that is closing — is
    // about to unmount. Armed before the write, consumed by the effect above
    // once the row has actually left the list.
    rescueFocusRef.current = true;
    announce(t("removed", { title: item.title }));
    removeDish.mutate({ id: item.id });
  }

  const hasMenu = data !== undefined;
  const isEmpty = hasMenu && data.items.length === 0;
  const inMenuDishIds = new Set((items ?? []).map((row) => row.dishId));

  return (
    <section className={styles.screen}>
      {/* Told before the tap, not after: with `networkMode: "always"` a write
          made offline fails immediately, and «нет связи» explains that better
          than a generic failure would. */}
      {online ? null : <p className={styles.offline}>{t("offline")}</p>}

      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t("title")}</h1>
        {hasMenu ? (
          <time className={styles.week} dateTime={`${data.weekStart}/${data.weekEnd}`}>
            {formatWeekRange(data.weekStart, data.weekEnd)}
          </time>
        ) : null}
        {hasMenu ? (
          <span className={styles.count}>
            {t("count", { count: data.items.length })}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.refreshButton}
          // `aria-disabled`, never `disabled`: a disabled control cannot hold
          // focus, and a keyboard user mid-toolbar would be thrown to the top
          // of the page the moment a refresh started.
          aria-disabled={isRefreshing || !online || undefined}
          onClick={isRefreshing || !online ? undefined : () => void refresh()}
          aria-label={t("refreshAria")}
          // A bare ⟳ names itself to a screen reader through `aria-label`,
          // but not to a mouse — no browser surfaces that as a tooltip.
          title={t("refresh")}
        >
          <span
            className={cx(
              styles.refreshIcon,
              isRefreshing && styles.refreshIconBusy,
            )}
            aria-hidden="true"
          >
            ⟳
          </span>
        </button>
      </div>

      {/* Additive, never an early return — see the screen's doc comment. */}
      {menu.isError ? (
        <div className={styles.error} role="alert">
          <p>{t("loadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void menu.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : null}

      {menu.isPending ? <MenuSkeleton label={t("loading")} /> : null}

      {/* The empty state replaces the *pool* only: the actions row below and
          the past-weeks block stay, because «+ Блюдо» is the way out of this
          state and 5.3's history is where a fresh week is repeated from. */}
      {isEmpty ? (
        <div className={styles.empty}>
          <div className={styles.emptyMark} aria-hidden="true">
            🗒
          </div>
          <p className={styles.emptyText}>{t("empty")}</p>
          {/* `main` deploys to production on every merge, so a chip that
              navigated nowhere would be worse than one that is honest. Task
              6.1 makes it real. */}
          <button
            type="button"
            className={styles.emptyAssistant}
            aria-disabled="true"
            onClick={() =>
              announce(t("soonHint", { action: t("emptyAssistant") }))
            }
          >
            {t("emptyAssistant")}
          </button>
        </div>
      ) : null}

      {items === undefined || items.length === 0 ? null : (
        <ul className={styles.pool}>
          {items.map((item) => (
            <MenuCard
              key={item.id}
              item={item}
              changed={changedIds.has(item.id)}
              onPortions={(delta) => changePortions(item, delta)}
              onCooked={(cooked) =>
                setCooked.mutate({ id: item.id, cooked })
              }
              onMore={(element) => {
                cardSheetOpener.captureOpener(element);
                setSheetItemId(item.id);
              }}
            />
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        {hasMenu && data.lastBuiltAt !== null && isBuiltInWeek(data.lastBuiltAt, data.weekStart) ? (
          <p className={styles.builtAt}>
            {t("builtAt", {
              // next-intl's formatter, not a raw `Intl` call: this component
              // renders on the server too, and next-intl resolves the zone
              // once and hands the same one to the client — the mismatch
              // `trip-history-section.tsx` warns about. A date rather than a
              // relative time, so SSR and hydration need no shared clock.
              date: format.dateTime(data.lastBuiltAt, {
                day: "numeric",
                month: "long",
              }),
            })}
          </p>
        ) : null}
        <div className={styles.actionRow}>
          <button
            ref={addButtonRef}
            type="button"
            className={styles.addButton}
            aria-label={t("addAria")}
            onClick={(event) => {
              pickerOpener.captureOpener(event.currentTarget);
              setPickerOpen(true);
            }}
          >
            {t("add")}
          </button>
          <BuildCartButton items={items ?? []} onAnnounce={announce} />
        </div>
      </div>

      <PastWeeksSection onAnnounce={announce} />

      {/* Permanently mounted with a keyed child, so two identical messages
          still announce twice. Spoken only: everything it reports is already
          visible as a card that moved, appeared or went away. */}
      <p className={styles.srOnly} role="status">
        <span key={hint?.seq ?? "empty"}>{hint?.text ?? ""}</span>
      </p>

      <DishPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        restoreFocusTo={pickerOpener.restoreFocusTo}
        inMenuDishIds={inMenuDishIds}
      />

      <BottomSheet
        open={sheetItem !== null}
        onClose={() => setSheetItemId(null)}
        title={t("moreAria", { title: sheetItem?.title ?? "" })}
        closeLabel={common("close")}
        restoreFocusTo={cardSheetOpener.restoreFocusTo}
      >
        {sheetItem === null ? null : (
          <ul className={styles.menu}>
            <li>
              {/* No confirmation: removal is idempotent on the server and
                  re-adding is two taps, so a modal would cost more than the
                  mistake it prevents. */}
              <button
                type="button"
                className={styles.menuRow}
                aria-label={t("removeAria", { title: sheetItem.title })}
                onClick={() => confirmRemove(sheetItem)}
              >
                {t("remove")}
              </button>
            </li>
            {online ? null : (
              <li>
                <p className={styles.offline}>{t("offline")}</p>
              </li>
            )}
          </ul>
        )}
      </BottomSheet>
    </section>
  );
}

/**
 * One card in the pool. Local to this screen (see the screen's doc comment)
 * and presentational apart from the two controls it owns, which is why it
 * binds its own translator rather than taking a dozen string props: it is
 * never rendered anywhere else.
 */
function MenuCard({
  item,
  changed,
  onPortions,
  onCooked,
  onMore,
}: {
  item: MenuItemOutput;
  changed: boolean;
  onPortions: (delta: number) => void;
  onCooked: (cooked: boolean) => void;
  onMore: (element: HTMLElement) => void;
}) {
  const t = useTranslations("menu");
  const [photoFailed, setPhotoFailed] = useState(false);

  const bounds = portionsRange(item.portionsBase);
  const portions = cardPortionsMessage(item);
  const cooked = item.cookedAt !== null;
  const showPhoto = item.photoUrl !== null && !photoFailed;

  const meta = [
    item.totalTimeMin === null ? null : t("cardTime", { minutes: item.totalTimeMin }),
    item.tags.length === 0 ? null : item.tags.join(", "),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <li
      className={cx(
        styles.card,
        cooked && styles.cardCooked,
        changed && styles.cardChanged,
      )}
    >
      <div className={styles.frame}>
        {showPhoto ? (
          /* Arbitrary remote hosts and no optimization budget — the same
             reasoning `DishCard` spells out for its own `<img>`. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.photo}
            src={item.photoUrl ?? undefined}
            alt={t("cardPhotoAlt", { title: item.title })}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <span className={styles.placeholder} aria-hidden="true">
            🍽
          </span>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.head}>
          <Link className={styles.cardTitle} href={`/dishes/${item.dishId}`}>
            {item.title}
          </Link>
          {/* A dish archived after it joined the pool stays here, fully
              usable — `dish.archiveHint`'s standing promise. */}
          {item.archivedAt === null ? null : (
            <span className={styles.archived}>{t("archived")}</span>
          )}
        </div>

        {meta.length === 0 ? null : <p className={styles.meta}>{meta}</p>}

        <div className={styles.controls}>
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepButton}
              aria-label={t("portionsDecreaseAria", { title: item.title })}
              aria-disabled={item.portions <= bounds.min || undefined}
              onClick={() => onPortions(-1)}
            >
              −
            </button>
            {/* A stepper's whole output is this number. */}
            <span className={styles.portions} aria-live="polite">
              {t(portions.key, portions.values)}
            </span>
            <button
              type="button"
              className={styles.stepButton}
              aria-label={t("portionsIncreaseAria", { title: item.title })}
              aria-disabled={item.portions >= bounds.max || undefined}
              onClick={() => onPortions(1)}
            >
              +
            </button>
          </div>

          {/* A real checkbox: it is a two-state fact about the card, and the
              list deliberately does **not** reorder when it flips — a card
              sliding out from under the finger that just ticked it is exactly
              what DESIGN_BRIEF §6 asks not to do. */}
          <label className={styles.cooked}>
            <input
              type="checkbox"
              className={styles.cookedInput}
              checked={cooked}
              aria-label={t("cookedAria", { title: item.title })}
              onChange={(event) => onCooked(event.target.checked)}
            />
            <span>{t("cooked")}</span>
          </label>

          <button
            type="button"
            className={styles.moreButton}
            aria-label={t("moreAria", { title: item.title })}
            onClick={(event) => onMore(event.currentTarget)}
          >
            …
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * S10's pending state, exported for `loading.tsx` so the route's fallback and
 * the screen's own first paint are the same rows under the same chrome.
 * Nothing here is focusable: a control that does nothing has no business
 * taking a tab stop.
 */
export function MenuSkeleton({ label }: { label: string }) {
  return (
    <ul className={styles.pool} role="status" aria-label={label}>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <li key={index} className={styles.skeletonCard}>
          <div className={styles.skeletonFrame} />
          <div className={styles.skeletonBody}>
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonMeta} />
          </div>
        </li>
      ))}
    </ul>
  );
}
