"use client";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { cx } from "@/lib/cx";
import { groupProductsByCategory } from "@/lib/group-products";
import {
  removePantryRow,
  restorePantryRow,
  type PantryRemovalSnapshot,
} from "@/lib/pantry/optimistic-remove";
import { describePantryRanOutOutcome } from "@/lib/pantry/ran-out-outcome";
import { cartSyncQueryOptions } from "@/lib/sync/cart-sync-presets";
import { useManualRefresh } from "@/lib/sync/use-manual-refresh";
import type { PantryListItemOutput } from "@/server/api/routers/pantry";
import { useTRPC } from "@/trpc/client";

import styles from "./pantry-screen.module.css";

/** The same beat S3's own toast uses (`cart-screen.tsx`). */
const TOAST_MS = 2500;

const SKELETON_SECTIONS = [
  [170, 120, 200],
  [140, 180],
];

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
 * **Deliberately out of scope for task 3.1** (per the plan row): the
 * «Ревизия» swipe-through mode (task 3.3) and long-tap «изменить продукт»
 * (mirrors the S3 row sheet, not built here). This screen is read-plus-one-
 * action, nothing more.
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
export function PantryScreen() {
  const t = useTranslations("pantry");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<{ message: string; seq: number } | null>(
    null,
  );
  const toastSeq = useRef(0);

  function showToast(message: string) {
    toastSeq.current += 1;
    setToast({ message, seq: toastSeq.current });
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

        let snapshot: PantryRemovalSnapshot<PantryListItemOutput> | null =
          null;
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
      onSuccess: (result) => {
        const action = describePantryRanOutOutcome(result);
        if (action.toastKey !== null) {
          showToast(t(action.toastKey));
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

  function handleRanOut(item: PantryListItemOutput) {
    if (pendingRef.current.has(item.id)) {
      return;
    }
    markPending(item.id, true);
    ranOut.mutate({ id: item.id });
  }

  const items = pantry.data ?? [];
  const sections = groupProductsByCategory(items);
  const hasList = pantry.data !== undefined;
  const isEmpty = hasList && items.length === 0;

  return (
    <section className={styles.screen}>
      <div className={styles.toolbar}>
        <h1 className={styles.toolbarTitle}>{t("title")}</h1>
        {hasList ? (
          <span className={styles.toolbarCount}>
            {t("count", { count: items.length })}
          </span>
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
        <div key={`${index}-${section.categoryId}`} className={styles.section}>
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
                      className={styles.ranOutButton}
                      aria-disabled={pending || undefined}
                      aria-busy={pending || undefined}
                      data-pending={pending || undefined}
                      onClick={() => handleRanOut(item)}
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

      <p className={styles.srOnly} role="status">
        {toast?.message ?? ""}
      </p>

      {toast === null ? null : (
        <p className={styles.toast} aria-hidden="true">
          {toast.message}
        </p>
      )}
    </section>
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
