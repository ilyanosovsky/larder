"use client";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useSheetOpener } from "@/components/use-sheet-opener";
import { cx } from "@/lib/cx";
import { groupProductsByCategory } from "@/lib/group-products";
import {
  removePantryRow,
  restorePantryRow,
  type PantryRemovalSnapshot,
} from "@/lib/pantry/optimistic-remove";
import { pickNextFocusTarget } from "@/lib/pantry/next-focus-target";
import { describePantryRanOutOutcome } from "@/lib/pantry/ran-out-outcome";
import { cartSyncQueryOptions } from "@/lib/sync/cart-sync-presets";
import { useManualRefresh } from "@/lib/sync/use-manual-refresh";
import type { PantryListItemOutput } from "@/server/api/routers/pantry";
import { useTRPC } from "@/trpc/client";

import styles from "./pantry-screen.module.css";
import { RevisionMode } from "./revision-mode";

/** The same beat S3's own toast uses (`cart-screen.tsx`). */
const TOAST_MS = 2500;

const SKELETON_SECTIONS = [
  [170, 120, 200],
  [140, 180],
];

/**
 * What the "flew off toward the cart" ghost (`purchases-screen.tsx`) needs to
 * animate — a plain `DOMRect` satisfies `rect` structurally, no cast needed.
 */
export interface PantryRanOutFlight {
  readonly icon: string;
  readonly name: string;
  readonly rect: { left: number; top: number; width: number; height: number };
}

/** Whether the OS/browser asks for reduced motion — checked at the moment of
 * the tap, not once at mount, since a setting change mid-session should take
 * effect on the very next tap. `matchMedia` is guarded rather than assumed:
 * this only ever runs from a click handler (browser-only), but a defensive
 * check costs nothing and keeps the function honest about its environment. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * S5 «Кладовая» (DESIGN_BRIEF §4, VISION §3.2) — "дома есть", grouped by
 * department the same way S3 is, with one action per row instead of a
 * checkbox.
 *
 * **«Кончилось» is optimistic, the same pattern the S3 checkbox set**: the
 * row disappears from the cache the instant it is tapped, and `pantry.ranOut`
 * settles in the background. Removal rather than a field patch, because a
 * pantry row's whole lifecycle *is* presence — there is no in-between state
 * for the row itself to show while the request is out (`useState`/`useRef`
 * pending marks below are purely for the still-visible window between the
 * tap and the optimistic patch landing, and for the row reappearing on
 * rollback).
 *
 * **Fire-and-observe, never `mutateAsync` awaited** (see `cart-screen.tsx`'s
 * own doc comment on the same rule): a mutation TanStack pauses for being
 * offline may not resolve for as long as the connection is down, and nothing
 * here should block on that.
 *
 * **Keyboard focus is moved deterministically, not left to the browser.** The
 * tapped «Кончилось» button is typically the focused element, and it
 * unmounts the instant the optimistic removal lands — a browser drops focus
 * to `<body>` in that case rather than picking a neighbour, throwing a
 * keyboard shopper back to the top of the page mid-list. `moveFocusAfterTap`
 * below computes the destination with `pickNextFocusTarget`
 * (`src/lib/pantry/next-focus-target.ts`, pure, tested) **before** the
 * removal even happens — the target row is still mounted at that instant, so
 * the move is synchronous with the tap rather than waiting on an effect tied
 * to the optimistic patch landing.
 *
 * **The fly-over ghost is owned by the parent** (`purchases-screen.tsx`):
 * this screen only reports *that* a row flew off and *from where*
 * (`onRanOutStart`) — the destination is the «Корзина» segment button, which
 * lives one level up and this screen has no business knowing about. Skipped
 * entirely under `prefers-reduced-motion`, checked here rather than by the
 * parent so no flight is ever constructed for one that will not be shown.
 *
 * **«Ревизия» (task 3.3, `revision-mode.tsx`)** is a separate full-screen
 * component this screen only launches — a toolbar button, `useSheetOpener`
 * for the focus-return-on-close convention, and `handleRevisionRanOut`
 * sharing the exact `ranOut` mutation instance below with the row button
 * (`fireRanOut` factors out the common "mark pending, remember the name,
 * mutate" half; each caller keeps its own pre-guard — the row's focus-move
 * and fly-over, the revision mode's own card animation and deck advance).
 * Long-tap «изменить продукт» (mirrors the S3 row sheet) is still not built
 * here — out of scope for both 3.1 and 3.3.
 *
 * Unlike the cart, `pantry.ranOut` is **not** wired into the IndexedDB
 * offline queue (`src/trpc/offline-queue.ts`): that queue's persistence
 * filter is still scoped to the `cart` router by design (see its own doc
 * comment), and widening it to a second router is a deliberate follow-up, not
 * a drive-by change to land inside this screen's PR. A tap made while offline
 * still *pauses* rather than fails — that much is TanStack's own default
 * behaviour, independent of this app's queue — and resumes automatically if
 * the app stays open until the connection returns; what it does not survive
 * is the app being killed while still offline, in which case the pantry row
 * simply reappears on the next load, nothing corrupted either side.
 */
export function PantryScreen({
  onRanOutStart,
}: {
  onRanOutStart: (flight: PantryRanOutFlight) => void;
}) {
  const t = useTranslations("pantry");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [revisionOpen, setRevisionOpen] = useState(false);
  const revisionOpener = useSheetOpener();

  const [toast, setToast] = useState<{
    visible: string;
    sr: string;
    seq: number;
  } | null>(null);
  const toastSeq = useRef(0);

  function showToast(visible: string, sr: string = visible) {
    toastSeq.current += 1;
    setToast({ visible, sr, seq: toastSeq.current });
  }

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Rows whose «Кончилось» is still in flight — a synchronous ref, not just
   * `pendingIds` state, for the same reason `cart-screen.tsx`'s `pendingRef`
   * is: `onMutate` has not necessarily run by the time a second tap on the
   * same row could land, so only a value written and read synchronously
   * actually stops it.
   */
  const pendingRef = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function markPending(id: string, pending: boolean) {
    if (pending) {
      pendingRef.current.add(id);
    } else {
      pendingRef.current.delete(id);
    }
    setPendingIds(new Set(pendingRef.current));
  }

  /**
   * Every row's «Кончилось» button, by product-row id — the only way to move
   * focus onto a *different* row than the one just tapped (`pickNextFocusTarget`
   * names an id; this is what turns that id into an actual DOM node).
   * A plain `Map` on a ref, not state: registering it is DOM bookkeeping, not
   * something a re-render should ever depend on.
   */
  const rowButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  /** The screen's own root — the fallback focus target once no other row is
   * left to land on (VISION §3.2: the pantry can run out to empty). */
  const screenRef = useRef<HTMLElement>(null);

  /**
   * The tapped row's product name, by pantry-row id — captured at tap time so
   * `onSuccess` can name it in the sr-only toast even though the row is
   * already gone from the cache by the time that callback runs. A plain ref
   * rather than the mutation's own context: threading it through `onMutate`'s
   * return value hit a context-typing dead end with this tRPC/TanStack
   * version's `onSuccess` overload, and a small id-keyed map sidesteps that
   * without depending on the fix landing upstream. Read once in `onSuccess`
   * and always cleared in `onSettled`, so it never accumulates entries beyond
   * however many «Кончилось» taps are genuinely in flight at once.
   */
  const pendingProductNames = useRef<Map<string, string>>(new Map());

  function registerRanOutButtonRef(
    id: string,
    el: HTMLButtonElement | null,
  ): void {
    if (el) {
      rowButtonRefs.current.set(id, el);
    } else {
      rowButtonRefs.current.delete(id);
    }
  }

  /**
   * Moves focus **before** `removedId`'s row is ever removed — the target is
   * still mounted at this instant, so there is no race to win against the
   * optimistic patch. `items` must be the list as it stood at the moment of
   * the tap (the caller's own render-scope value, not something re-read
   * later), which is exactly what `pickNextFocusTarget` needs to name a
   * neighbour by the row that is about to disappear.
   */
  function moveFocusAfterTap(
    items: readonly PantryListItemOutput[],
    removedId: string,
  ): void {
    const targetId = pickNextFocusTarget(items, removedId);
    const target =
      targetId === null
        ? screenRef.current
        : (rowButtonRefs.current.get(targetId) ?? screenRef.current);
    target?.focus();
  }

  const pantryFilter = trpc.pantry.list.queryFilter();
  const pantryKey = trpc.pantry.list.queryKey();
  const cartFilter = trpc.cart.list.queryFilter();

  /** Mutes the passive refetch triggers while one of our own taps is out —
   * the same reasoning `cart-screen.tsx` mutes `cart.list`'s triggers while
   * `useIsMutating(trpc.cart.pathKey())` is non-zero: a poll or a focus event
   * landing between the optimistic removal and the write settling would
   * otherwise answer with the pre-tap list and visibly resurrect the row. */
  const pantryMutating =
    useIsMutating({ mutationKey: trpc.pantry.pathKey() }) > 0;

  const pantry = useQuery(
    trpc.pantry.list.queryOptions(undefined, {
      ...cartSyncQueryOptions,
      ...(pantryMutating
        ? {
            refetchInterval: false as const,
            refetchOnWindowFocus: false as const,
            refetchOnReconnect: false as const,
          }
        : {}),
    }),
  );
  const { refresh, isRefreshing } = useManualRefresh(pantryFilter);

  const ranOut = useMutation(
    trpc.pantry.ranOut.mutationOptions({
      onMutate: async (variables) => {
        await queryClient.cancelQueries(pantryFilter);

        let snapshot: PantryRemovalSnapshot<PantryListItemOutput> | null = null;
        queryClient.setQueryData(pantryKey, (current) => {
          if (current === undefined) {
            return current;
          }
          const result = removePantryRow(current, variables.id);
          snapshot = result.snapshot;
          return result.list;
        });

        return { snapshot };
      },
      onSuccess: (result, variables) => {
        const action = describePantryRanOutOutcome(result);
        if (action.toastKey !== null) {
          // The row is already gone from the cache by the time this runs, so
          // the product name for the **sr-only** announcement has to come
          // from `pendingProductNames` (captured at tap time), not from a
          // fresh cache read. `added`/`restored` render the identical
          // visible string every time (DESIGN_BRIEF keeps it generic), which
          // means a second identical tap within the toast's own window
          // mutates nothing in the live region — no text change, no
          // announcement. Naming the product makes every event's sr text
          // distinct.
          const name = pendingProductNames.current.get(variables.id);
          showToast(
            t(action.toastKey),
            name === undefined
              ? t(action.toastKey)
              : t(`${action.toastKey}Sr`, { name }),
          );
        }
        // The cart may have gained or changed a line — S3 catches up on its
        // own poll regardless, but invalidating means it is not stale the
        // moment someone switches tabs to look. Unconditional, `gone`
        // included: `gone` commonly means a partner's own tap won the same
        // race and already ensured the cart row a moment before this one
        // read the pantry row as already deleted — that row is exactly the
        // thing worth not showing stale.
        void queryClient.invalidateQueries(cartFilter);
      },
      onError: (_error, _variables, context) => {
        if (context?.snapshot) {
          const snapshot = context.snapshot;
          queryClient.setQueryData(pantryKey, (current) =>
            current === undefined
              ? current
              : restorePantryRow(current, snapshot),
          );
        }
        showToast(t("ranOutError"));
      },
      onSettled: (_data, _error, variables) => {
        markPending(variables.id, false);
        pendingProductNames.current.delete(variables.id);
        // Deferred until every outstanding «Кончилось» has settled, not
        // fired per mutation: with two rows in flight, an earlier settle's
        // refetch would land while the later one is still pending — the
        // server list it fetches still includes that row, and applying it
        // wholesale would resurrect a row this screen already optimistically
        // removed, out from under a request still on the wire. The
        // `pantryMutating` option above mutes the *passive* refetch triggers
        // for the same reason, but does not reach this explicit call.
        if (pendingRef.current.size === 0) {
          void queryClient.invalidateQueries(pantryFilter);
        }
      },
    }),
  );

  /**
   * The "mark pending, remember the name, actually mutate" half of
   * «Кончилось» — shared verbatim between the row's own button
   * (`handleRanOut`) and «Ревизия» (`handleRevisionRanOut`, task 3.3): same
   * optimistic cache removal, rollback and outcome toast either way, since
   * both ultimately just call this `ranOut` mutation.
   *
   * Deliberately **not** the pending-guard check itself — callers each have
   * their own pre-guard work to do first (the row moves focus and starts the
   * fly-over; the revision mode advances its own deck and plays its own card
   * animation), and none of that should run for an id that is already in
   * flight. Every caller checks `pendingRef` before doing anything, this
   * function included.
   */
  function fireRanOut(item: PantryListItemOutput) {
    markPending(item.id, true);
    pendingProductNames.current.set(item.id, item.productName);
    ranOut.mutate({ id: item.id });
  }

  function handleRanOut(
    item: PantryListItemOutput,
    buttonEl: HTMLButtonElement,
  ) {
    if (pendingRef.current.has(item.id)) {
      return;
    }

    // Both read the pre-removal list/DOM, synchronously, before anything
    // about the row changes.
    moveFocusAfterTap(items, item.id);
    if (!prefersReducedMotion()) {
      onRanOutStart({
        icon: item.productIcon,
        name: item.productName,
        rect: buttonEl.getBoundingClientRect(),
      });
    }

    fireRanOut(item);
  }

  /**
   * «Кончилось» as decided from inside «Ревизия» (`revision-mode.tsx`) — the
   * same `ranOut` mutation `handleRanOut` fires, minus the row-button-only
   * parts: there is no list row to move focus away from (the underlying
   * list isn't even visible behind the full-screen overlay) and no
   * fly-to-cart ghost (`revision-mode.tsx` has its own card-exit animation
   * instead, DESIGN_BRIEF makes no mention of the ghost for this mode).
   */
  function handleRevisionRanOut(item: PantryListItemOutput) {
    if (pendingRef.current.has(item.id)) {
      return;
    }
    fireRanOut(item);
  }

  const items = pantry.data ?? [];
  const sections = groupProductsByCategory(items);
  const hasList = pantry.data !== undefined;
  const isEmpty = hasList && items.length === 0;

  return (
    <>
      <section
        ref={screenRef}
        className={styles.screen}
        // Programmatic-only focus target (`moveFocusAfterTap`'s fallback), so
        // it needs a name to announce when it actually receives focus — the
        // visible `<h1>` right below already says the same thing, but that
        // does not by itself give this container an accessible name of its
        // own to read out.
        tabIndex={-1}
        aria-label={t("title")}
      >
        <div className={styles.toolbar}>
          <h1 className={styles.toolbarTitle}>{t("title")}</h1>
          {hasList ? (
            <span className={styles.toolbarCount}>
              {t("count", { count: items.length })}
            </span>
          ) : null}
          {/* Hidden rather than disabled on an empty pantry (DESIGN_BRIEF S5,
            task 3.3) — there is nothing a run through zero cards would show
            beyond the summary screen's own "всё на месте" copy, so offering
            the button at all would just be a detour to the same empty-state
            message the toolbar already communicates via `isEmpty` below. */}
          {hasList && !isEmpty ? (
            <button
              type="button"
              className={styles.revisionButton}
              onClick={(event) => {
                revisionOpener.captureOpener(event.currentTarget);
                setRevisionOpen(true);
              }}
              aria-label={t("revisionAria")}
            >
              {t("revision")}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.refreshButton}
            onClick={() => void refresh()}
            disabled={isRefreshing || pantryMutating}
            aria-label={t("refreshAria")}
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

        {pantry.isError ? (
          <p className={styles.error} role="alert">
            {t("loadFailed")}
          </p>
        ) : null}

        {pantry.isPending ? <PantrySkeleton label={t("loading")} /> : null}

        {isEmpty ? (
          <div className={styles.empty}>
            <div className={styles.emptyMark} aria-hidden="true">
              🗄️
            </div>
            <p className={styles.emptyText}>{t("empty")}</p>
          </div>
        ) : null}

        {sections.map((section, index) => (
          <div
            key={`${index}-${section.categoryId}`}
            className={styles.section}
          >
            <h2 className={styles.sectionHeader}>
              <span aria-hidden="true">{section.icon}</span>
              <span className={styles.sectionName}>{section.name}</span>
              <span className={styles.sectionCount}>
                {t("sectionCount", { count: section.items.length })}
              </span>
            </h2>

            <ul className={styles.rows}>
              {section.items.map((item) => {
                const pending = pendingIds.has(item.id);

                return (
                  <li key={item.id}>
                    <div className={styles.row}>
                      <span className={styles.rowIcon} aria-hidden="true">
                        {item.productIcon}
                      </span>
                      <span className={styles.rowName}>{item.productName}</span>
                      <button
                        type="button"
                        ref={(el) => registerRanOutButtonRef(item.id, el)}
                        className={styles.ranOutButton}
                        aria-disabled={pending || undefined}
                        aria-busy={pending || undefined}
                        data-pending={pending || undefined}
                        onClick={(event) =>
                          handleRanOut(item, event.currentTarget)
                        }
                      >
                        {t("ranOut")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* `toast.seq` keys the *child*, never the region itself. This `<p>` is
            mounted once for the life of the screen and never again — the same
            reasoning `cart-screen.tsx`'s own live region documents: a
            `role="status"` node that appears together with its content is not
            reliably announced, since assistive tech has to already be watching
            the node before the text arrives. What a stable region does *not*
            fix on its own is React skipping an in-place text update when the
            new string is identical to the old one — naming the product in
            `toast.sr` closes that for the common case, but not for two
            consecutive `ranOutError` toasts, which carry no product name and
            are byte-identical. A changed `key` forces React to unmount the old
            child and mount a fresh one instead of patching text in place — a
            real node replacement inside the already-live region, which
            assistive tech observes as a mutation regardless of whether the
            text itself repeats. */}
        <p className={styles.srOnly} role="status">
          <span key={toast?.seq ?? "empty"}>{toast?.sr ?? ""}</span>
        </p>

        {toast === null ? null : (
          <p className={styles.toast} aria-hidden="true">
            {toast.visible}
          </p>
        )}
      </section>

      {revisionOpen ? (
        <RevisionMode
          items={items}
          onRanOut={handleRevisionRanOut}
          onClose={() => setRevisionOpen(false)}
          restoreFocusTo={revisionOpener.restoreFocusTo}
        />
      ) : null}
    </>
  );
}

function PantrySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      {SKELETON_SECTIONS.map((widths, sectionIndex) => (
        <div key={sectionIndex}>
          <div className={styles.skeletonHeader}>
            <span className={styles.skeletonHeaderBar} />
          </div>
          {widths.map((width, rowIndex) => (
            <div key={rowIndex} className={styles.skeletonRow}>
              <span className={styles.skeletonBox} />
              <span className={styles.skeletonName} style={{ width }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
