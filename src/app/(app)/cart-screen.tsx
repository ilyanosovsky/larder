"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import {
  AutocompleteSheet,
  type ProductSelection,
} from "@/components/autocomplete-sheet";
import { BottomSheet } from "@/components/bottom-sheet";
import { useSheetOpener } from "@/components/use-sheet-opener";
import {
  describeCartAddOutcome,
  type CartAddToastKey,
} from "@/lib/cart/add-outcome";
import { sortBoughtLast } from "@/lib/cart/sort-rows";
import { applyStatusToggle, toggledCartStatus } from "@/lib/cart/status-toggle";
import { groupProductsByCategory } from "@/lib/group-products";
import { cartSyncQueryOptions } from "@/lib/sync/cart-sync-presets";
import { HIGHLIGHT_MS, useChangedRows } from "@/lib/sync/use-changed-rows";
import { useManualRefresh } from "@/lib/sync/use-manual-refresh";
import type { CartListItemOutput } from "@/server/api/routers/cart";
import { useTRPC } from "@/trpc/client";

import styles from "./cart-screen.module.css";

/** How long a toast stays up — the same beat the S4 sheet's own uses. */
const TOAST_MS = 2500;

/** Name-bar widths for the first-load skeleton (mockup 1e), in px. */
const SKELETON_SECTIONS = [
  [170, 120, 200],
  [140, 180],
];

/** Joins the class names that apply and skips the ones that do not. */
function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Where the «+ Добавить» flow currently is. One sheet is open at a time on
 * purpose: `boughtExists` closes S4 and opens the confirmation rather than
 * stacking a second modal on top of it, so focus, the Esc key and the page's
 * scroll lock all stay owned by exactly one `BottomSheet`.
 */
type AddFlow =
  | { kind: "closed" }
  | { kind: "search" }
  | { kind: "confirmRestore"; selection: ProductSelection };

/**
 * S3 «Корзина» (DESIGN_BRIEF §4, mockups 1a–1e) — the product's main screen.
 *
 * Three things carry the design here:
 *
 * **Sections are the database's opinion, not the screen's.** `cart.list`
 * returns rows in walking order (department `sortOrder`, then product name)
 * and `groupProductsByCategory` cuts that run into sections by walking it.
 * The only reordering this screen does is `sortBoughtLast` *inside* a section,
 * which is DESIGN_BRIEF S3's «строка опускается вниз секции».
 *
 * **The checkbox is optimistic and last-write-wins.** It has to work at the
 * till on a bad connection, so the cache is patched before the request leaves
 * and rolled back if it fails — never a spinner between the tap and the tick.
 *
 * **Freshness is a refetch, not a push** (VISION §6.3): the 45s poll,
 * refetch-on-focus and «Обновить» all come from `src/lib/sync/`, and whatever
 * a refetch changed gets the soft highlight of mockup 1b.
 *
 * Deferred by design: the «Корзина | Кладовая» segment control (3.1),
 * «Завершить закупку» (3.2), the offline banner and 🕐 marks (2.4), and the
 * «Заказано» badge, «кто берёт» avatar and note editing (2.5). An existing
 * note is rendered — the data is already on the wire — but nothing here can
 * set one.
 */
export function CartScreen() {
  const t = useTranslations("cart");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const addOpener = useSheetOpener();

  const [flow, setFlow] = useState<AddFlow>({ kind: "closed" });
  const [toast, setToast] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /**
   * Rows whose `setStatus` is still in flight.
   *
   * Held in a ref *as well as* in state because the guard has to be
   * synchronous with the tap: `disabled` only lands on the next render, and
   * `onMutate` does not run until `mutate()` has handed off — so a second tap
   * in the same tick would otherwise get through. Two `setStatus` calls for
   * one row genuinely race, and last-write-wins would then settle on
   * whichever request happened to arrive second rather than on what the
   * shopper last tapped. The state copy is only what renders `disabled`.
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

  const cartFilter = trpc.cart.list.queryFilter();
  const cartKey = trpc.cart.list.queryKey();

  const cart = useQuery(
    trpc.cart.list.queryOptions(undefined, { ...cartSyncQueryOptions }),
  );
  const { refresh, isRefreshing } = useManualRefresh(cartFilter);

  // The query's own array reference, deliberately not a derived one: the
  // hook's effect keys off it, and a fresh array every render would make it
  // re-diff on every render instead of on an actual refetch.
  const { changedIds } = useChangedRows(cart.data);

  /**
   * A highlight this screen asked for, on top of the ones a refetch produced.
   *
   * `useChangedRows` can only notice a row whose `updatedAt` moved, which is
   * exactly what `unitMismatch` and `boughtExists` do *not* do — and the row
   * they are about is the one the shopper needs to find. `seq` makes the
   * effect below restart its timer even when the same row lights up twice.
   */
  const [highlight, setHighlight] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const highlightSeq = useRef(0);

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (highlight === null) {
      return;
    }
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  function highlightRow(id: string) {
    highlightSeq.current += 1;
    setHighlight({ id, seq: highlightSeq.current });
  }

  /**
   * The first optimistic mutation in the app, and the pattern the rest should
   * copy: cancel in-flight refetches so none of them lands on top of the
   * patch, snapshot, patch, hand the snapshot back as rollback context, and
   * invalidate once the server has spoken either way.
   */
  const setStatus = useMutation(
    trpc.cart.setStatus.mutationOptions({
      onMutate: async (variables) => {
        // Without this, a refetch already in flight would resolve *after* the
        // patch and overwrite it with the pre-tap list — the checkbox would
        // visibly un-tick itself a moment later.
        await queryClient.cancelQueries(cartFilter);

        const previous = queryClient.getQueryData(cartKey);
        queryClient.setQueryData(cartKey, (current) =>
          current === undefined
            ? current
            : applyStatusToggle(current, variables.id, variables.status),
        );

        return { previous };
      },
      onError: (_error, _variables, context) => {
        if (context?.previous !== undefined) {
          queryClient.setQueryData(cartKey, context.previous);
        }
        setToast(t("statusError"));
      },
      onSettled: (_data, _error, variables) => {
        markPending(variables.id, false);
        void queryClient.invalidateQueries(cartFilter);
      },
    }),
  );

  const add = useMutation(trpc.cart.add.mutationOptions());

  function toggleStatus(item: CartListItemOutput) {
    // Per row rather than per screen: ticking three things one after another
    // is ordinary shopping and must never be blocked, but a second tap on the
    // *same* row while its request is out is the one case that races.
    if (pendingRef.current.has(item.id)) {
      return;
    }
    markPending(item.id, true);
    setStatus.mutate({ id: item.id, status: toggledCartStatus(item.status) });
  }

  function toastFor(key: CartAddToastKey, selection: ProductSelection): string {
    return key === "toastAdded"
      ? t(key, {
          icon: selection.product.icon,
          name: selection.product.name,
        })
      : t(key, { name: selection.product.name });
  }

  /**
   * Files a selection and does whatever the outcome asks for. Deliberately
   * lets a failure reject: S4 is still on screen at that point and shows the
   * error where the shopper is looking. The restore confirmation, which has
   * no such place, catches it itself.
   */
  async function submitAdd(selection: ProductSelection, restore: boolean) {
    const result = await add.mutateAsync({
      productId: selection.product.id,
      qty: selection.qty,
      unit: selection.unit,
      restore,
    });

    const action = describeCartAddOutcome(result);
    highlightRow(action.highlightId);
    void queryClient.invalidateQueries(cartFilter);

    if (action.needsRestoreConfirm) {
      setConfirmError(null);
      setFlow({ kind: "confirmRestore", selection });
      return;
    }

    setFlow({ kind: "closed" });
    if (action.toastKey !== null) {
      setToast(toastFor(action.toastKey, selection));
    }
  }

  async function confirmRestore(selection: ProductSelection) {
    // Same one-tick window every other mutation in this app guards: `disabled`
    // only lands on the next render.
    if (add.isPending) {
      return;
    }
    setConfirmError(null);
    try {
      await submitAdd(selection, true);
    } catch {
      setConfirmError(t("addError"));
    }
  }

  const items = cart.data ?? [];
  const sections = groupProductsByCategory(items);
  // Keyed off the data rather than off `isSuccess`: a failed refetch on top of
  // a list already on screen leaves `status: "error"`, and the count has no
  // business disappearing from above rows that are still there.
  const hasList = cart.data !== undefined;
  const isEmpty = hasList && items.length === 0;

  function openSearch(element: HTMLElement | null) {
    addOpener.captureOpener(element);
    setFlow({ kind: "search" });
  }

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
          disabled={isRefreshing}
          aria-label={t("refreshAria")}
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

      {cart.isError ? (
        <p className={styles.error} role="alert">
          {t("loadFailed")}
        </p>
      ) : null}

      {cart.isPending ? <CartSkeleton label={t("loading")} /> : null}

      {isEmpty ? (
        <div className={styles.empty}>
          <div className={styles.emptyMark} aria-hidden="true">
            🧺
          </div>
          <p className={styles.emptyText}>{t("empty")}</p>
          <button
            type="button"
            className={styles.addButton}
            onClick={(event) => openSearch(event.currentTarget)}
            aria-label={t("addAria")}
          >
            + {t("add")}
          </button>
        </div>
      ) : null}

      {/* Keyed by position as well as department: `groupProductsByCategory`
          starts a new section every time the run changes, so a list that
          arrives with a department split across two runs would otherwise
          yield two sections sharing one key. */}
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
            {sortBoughtLast(section.items).map((item) => {
              const bought = item.status === "bought";

              return (
                <li key={item.id}>
                  {/* The whole row is the label, so the checkbox's accessible
                      name is «Помидоры 6 шт» and the tap target is the line
                      rather than a 20px square. */}
                  <label
                    className={cx(
                      styles.row,
                      bought && styles.rowBought,
                      (changedIds.has(item.id) || highlight?.id === item.id) &&
                        styles.rowChanged,
                    )}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={bought}
                      disabled={pendingIds.has(item.id)}
                      onChange={() => toggleStatus(item)}
                    />
                    <span className={styles.checkboxMark} aria-hidden="true">
                      ✓
                    </span>
                    <span className={styles.rowIcon} aria-hidden="true">
                      {item.productIcon}
                    </span>
                    <span className={styles.rowName}>
                      {item.productName}
                      {item.note === null ? null : (
                        <span className={styles.rowNote}>
                          {t("noteInline", { note: item.note })}
                        </span>
                      )}
                    </span>
                    <span className={styles.rowQty}>
                      {t("qtyValue", { qty: item.qty, unit: item.unit })}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {isEmpty ? null : (
        <div className={styles.actionBar}>
          <button
            type="button"
            className={styles.addButton}
            onClick={(event) => openSearch(event.currentTarget)}
            aria-label={t("addAria")}
          >
            + {t("add")}
          </button>
        </div>
      )}

      {toast === null ? null : (
        <p className={styles.toast} role="status">
          {toast}
        </p>
      )}

      <AutocompleteSheet
        open={flow.kind === "search"}
        onClose={() => setFlow({ kind: "closed" })}
        restoreFocusTo={addOpener.restoreFocusTo}
        onAdded={(selection) => submitAdd(selection, false)}
      />

      <BottomSheet
        open={flow.kind === "confirmRestore"}
        onClose={() => setFlow({ kind: "closed" })}
        title={t("restoreTitle")}
        closeLabel={tCommon("close")}
        restoreFocusTo={addOpener.restoreFocusTo}
      >
        {flow.kind === "confirmRestore" ? (
          <div className={styles.confirm}>
            <p className={styles.confirmQuestion}>
              {t("restoreQuestion", { name: flow.selection.product.name })}
            </p>

            {confirmError === null ? null : (
              <p className={styles.error} role="alert">
                {confirmError}
              </p>
            )}

            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmCancel}
                onClick={() => setFlow({ kind: "closed" })}
              >
                {tCommon("cancel")}
              </button>
              <button
                type="button"
                className={styles.addButton}
                onClick={() => void confirmRestore(flow.selection)}
                disabled={add.isPending}
              >
                {add.isPending
                  ? t("restoreConfirmPending")
                  : t("restoreConfirm")}
              </button>
            </div>
          </div>
        ) : null}
      </BottomSheet>
    </section>
  );
}

/**
 * Mockup 1e: the shape of the list before the list exists — section rules and
 * row blocks in the paper's own greys, so the first paint is the page rather
 * than a spinner on an empty screen.
 */
function CartSkeleton({ label }: { label: string }) {
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
              <span className={styles.skeletonQty} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
