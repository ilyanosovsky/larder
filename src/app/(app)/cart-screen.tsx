"use client";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import {
  AutocompleteSheet,
  type ProductSelection,
} from "@/components/autocomplete-sheet";
import { BottomSheet } from "@/components/bottom-sheet";
import {
  CartItemSheet,
  type CartItemSheetMember,
} from "@/components/cart-item-sheet";
import { useSheetOpener } from "@/components/use-sheet-opener";
import {
  describeCartAddOutcome,
  type CartAddToastKey,
} from "@/lib/cart/add-outcome";
import { markOwnChange, withoutOwnChanges } from "@/lib/cart/own-changes";
import {
  applyReceiveOrder,
  groupOrderedByService,
  receivableServiceGroups,
  rollbackReceiveOrder,
  type ReceiveOrderSnapshot,
} from "@/lib/cart/receive-order";
import { sortBoughtLast } from "@/lib/cart/sort-rows";
import { applyStatusToggle, toggledCartStatus } from "@/lib/cart/status-toggle";
import { avatarInitial } from "@/lib/avatar-initial";
import { cx } from "@/lib/cx";
import { groupProductsByCategory } from "@/lib/group-products";
import type { OrderedVia } from "@/lib/ordered-via";
import { cartSyncQueryOptions } from "@/lib/sync/cart-sync-presets";
import { HIGHLIGHT_MS, useChangedRows } from "@/lib/sync/use-changed-rows";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { useManualRefresh } from "@/lib/sync/use-manual-refresh";
import { useQueuedCartRows } from "@/lib/sync/use-queued-rows";
import type { CartListItemOutput } from "@/server/api/routers/cart";
import type { CartItemStatus } from "@/server/cart/merge";
import { useTRPC } from "@/trpc/client";

import styles from "./cart-screen.module.css";

/** How long a toast stays up — the same beat the S4 sheet's own uses. */
const TOAST_MS = 2500;

/** Name-bar widths for the first-load skeleton (mockup 1e), in px. */
const SKELETON_SECTIONS = [
  [170, 120, 200],
  [140, 180],
];

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
 * **Offline is a state of the screen, not an error** (task 2.4, mockup 1c):
 * the banner and the per-row 🕐 marks both read TanStack's own queue —
 * `onlineManager` and the mutation cache — so what they say cannot drift from
 * what is actually waiting to be delivered.
 *
 * **The row action sheet** (task 2.5, `CartItemSheet`) opens on a tap
 * anywhere in a row's *body* — never the checkbox, which must keep doing
 * exactly one thing. It edits qty/unit/note, «кто берёт» and «заказано»
 * through plain mutate-and-invalidate: none of that is perf-critical the way
 * the checkbox is, so there is no optimistic patch to keep in sync there.
 *
 * Deferred by design: the «Корзина | Кладовая» segment control (3.1) and
 * «Завершить закупку» (3.2).
 */
export function CartScreen() {
  const t = useTranslations("cart");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const addOpener = useSheetOpener();
  const editOpener = useSheetOpener();

  const [flow, setFlow] = useState<AddFlow>({ kind: "closed" });
  /** Which row's action sheet is open, or `null`. */
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /**
   * `seq` is what makes the dismiss timer restart when the *same* message is
   * raised twice — adding «Помидоры» twice in a row is ordinary, and a plain
   * string in state would leave the effect's `[toast]` dependency unchanged,
   * so the second toast would inherit the remains of the first one's 2.5s.
   */
  const [toast, setToast] = useState<{ message: string; seq: number } | null>(
    null,
  );
  const toastSeq = useRef(0);

  function showToast(message: string) {
    toastSeq.current += 1;
    setToast({ message, seq: toastSeq.current });
  }

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

  /**
   * Any `cart.*` mutation of ours in flight. `pathKey()` is tRPC's
   * router-level key and TanStack matches mutation keys by prefix, so this is
   * already the shared key across `setStatus`, `add`, `updateItem`, `remove`
   * and `receiveOrder` (task 2.5) — tRPC sets `mutationKey` itself, after
   * spreading the caller's options, so it cannot be overridden per call site
   * anyway.
   */
  const cartMutating = useIsMutating({ mutationKey: trpc.cart.pathKey() }) > 0;

  const isOnline = useIsOnline();

  const cart = useQuery(
    trpc.cart.list.queryOptions(undefined, {
      ...cartSyncQueryOptions,
      /**
       * The passive refetch triggers are muted while one of our own writes is
       * out.
       *
       * `onMutate`'s `cancelQueries` only stops what is already in flight; a
       * trigger that fires *after* it — the 45s tick, a focus event under
       * `refetchOnWindowFocus: "always"` — starts a fresh request that was
       * dispatched before the write landed, so it answers with the pre-write
       * list and visibly un-ticks the row until `onSettled`'s invalidate
       * repairs it. Nothing is lost by waiting: that invalidate refetches the
       * moment the write settles.
       *
       * The residual is a genuine last-write-wins tolerance rather than a
       * gap: if the partner writes the same row in the same instant, one of
       * the two wins and the next refetch shows it. VISION §3.1 accepts that.
       */
      ...(cartMutating
        ? {
            refetchInterval: false as const,
            refetchOnWindowFocus: false as const,
            refetchOnReconnect: false as const,
          }
        : {}),
    }),
  );
  const { refresh, isRefreshing } = useManualRefresh(cartFilter);

  // The query's own array reference, deliberately not a derived one: the
  // hook's effect keys off it, and a fresh array every render would make it
  // re-diff on every render instead of on an actual refetch.
  const { changedIds } = useChangedRows(cart.data);

  /**
   * Rows this client changed itself, muting the partner-change highlight for
   * them — see `src/lib/cart/own-changes.ts` for why the refetch cannot tell
   * whose change it is looking at, and why the mark is time-bounded.
   *
   * Scoped to `setStatus` on purpose. The add flow's own highlight is wanted
   * (mockup #1h: «количество обновлено» has to point at the row it merged
   * into), and it is drawn from `highlight` below rather than from the diff.
   */
  const ownChangesRef = useRef<Map<string, number>>(new Map());

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

  /** Patches one row's status in the cached list, if the row is still there. */
  function patchCachedStatus(id: string, status: CartItemStatus) {
    queryClient.setQueryData(cartKey, (current) =>
      current === undefined ? current : applyStatusToggle(current, id, status),
    );
  }

  /**
   * The first optimistic mutation in the app, and the pattern the rest should
   * copy: cancel in-flight refetches so none of them lands on top of the
   * patch, patch, remember what the row held, undo exactly that row if the
   * request fails, and invalidate once the server has spoken either way.
   */
  const setStatus = useMutation(
    trpc.cart.setStatus.mutationOptions({
      onMutate: async (variables) => {
        // Without this, a refetch already in flight would resolve *after* the
        // patch and overwrite it with the pre-tap list — the checkbox would
        // visibly un-tick itself a moment later. (Triggers that fire *later*
        // are handled by the mute in `queryOptions` above.)
        await queryClient.cancelQueries(cartFilter);

        // The server is about to stamp `updatedAt`, and the invalidate below
        // will diff that against the pre-tap snapshot. Marked here, before
        // the write, so the partner-change highlight never fires at you for
        // your own tick.
        markOwnChange(
          ownChangesRef.current,
          variables.id,
          Date.now(),
          HIGHLIGHT_MS,
        );

        const previousStatus = queryClient
          .getQueryData(cartKey)
          ?.find((row) => row.id === variables.id)?.status;

        patchCachedStatus(variables.id, variables.status);

        return { previousStatus };
      },
      /**
       * Undoes **this row**, rather than restoring a whole-list snapshot.
       *
       * Overlapping toggles are ordinary — ticking down a shelf is exactly
       * that — and a snapshot taken before row A's request knows nothing
       * about row B's. Restoring it would wipe B's optimistic tick when A
       * fails, and re-apply A's when B fails. A per-row inverse touches only
       * what actually failed; `onSettled`'s invalidate is the healer for
       * everything else.
       */
      onError: (_error, variables, context) => {
        if (context?.previousStatus !== undefined) {
          patchCachedStatus(variables.id, context.previousStatus);
        }
        showToast(t("statusError"));
      },
      onSettled: (_data, error, variables) => {
        markPending(variables.id, false);

        /**
         * Marked **again**, at the moment the write actually lands.
         *
         * `onMutate`'s mark is stamped with `now + HIGHLIGHT_MS`, which is
         * the right window for a tap delivered in the next 200ms. A tap made
         * offline is delivered when the connection comes back — minutes
         * later — and by then that mark is long expired, so the refetch
         * below would report the row as changed and light it up as
         * «партнёр что-то поменял» for something the shopper did themselves.
         * Re-marking here covers the refetch this line is about to trigger,
         * whenever that turns out to be.
         *
         * Only on success: a failed write changed nothing on the server, so
         * there is no refetch result to suppress — and suppressing anyway
         * would mute a partner's genuine change to the same row.
         */
        if (error === null) {
          markOwnChange(
            ownChangesRef.current,
            variables.id,
            Date.now(),
            HIGHLIGHT_MS,
          );
        }

        void queryClient.invalidateQueries(cartFilter);
      },
    }),
  );

  const add = useMutation(trpc.cart.add.mutationOptions());

  /**
   * Rows whose bulk «Заказ получен» is still in flight, keyed by service
   * (`group.orderedVia ?? "__none__"`) — the receive bar shows at most a
   * handful of buttons, so one ref-then-state pair covers all of them, the
   * same pairing `pendingRef`/`pendingIds` uses for the checkbox.
   */
  const receivePendingRef = useRef<Set<string>>(new Set());
  const [receivePendingKeys, setReceivePendingKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());

  function receiveGroupKey(orderedVia: OrderedVia | null): string {
    return orderedVia ?? "__none__";
  }

  function markReceivePending(key: string, pending: boolean) {
    if (pending) {
      receivePendingRef.current.add(key);
    } else {
      receivePendingRef.current.delete(key);
    }
    setReceivePendingKeys(new Set(receivePendingRef.current));
  }

  /** Applies `applyReceiveOrder` to the cached list, if it is loaded at all. */
  function patchCachedReceive(
    orderedVia: OrderedVia | null | undefined,
  ): ReceiveOrderSnapshot[] {
    let snapshots: ReceiveOrderSnapshot[] = [];
    queryClient.setQueryData(cartKey, (current) => {
      if (current === undefined) {
        return current;
      }
      const result = applyReceiveOrder(current, orderedVia);
      snapshots = result.snapshots;
      return result.list;
    });
    return snapshots;
  }

  /**
   * «Заказ получен» — the bulk counterpart of the checkbox's optimistic
   * toggle, adapted to a batch: the per-row inverse becomes a rollback over
   * only the rows `applyReceiveOrder` actually touched (never a whole-list
   * snapshot, for the same reason the checkbox's rollback is per row — an
   * unrelated tick landing mid-flight must survive it), and the own-change
   * mark is written for every one of those rows rather than one id.
   */
  const receiveOrder = useMutation(
    trpc.cart.receiveOrder.mutationOptions({
      onMutate: async (variables) => {
        await queryClient.cancelQueries(cartFilter);

        const snapshots = patchCachedReceive(variables.orderedVia);
        const now = Date.now();
        for (const snapshot of snapshots) {
          markOwnChange(ownChangesRef.current, snapshot.id, now, HIGHLIGHT_MS);
        }

        return { snapshots };
      },
      onError: (_error, _variables, context) => {
        if (context && context.snapshots.length > 0) {
          queryClient.setQueryData(cartKey, (current) =>
            current === undefined
              ? current
              : rollbackReceiveOrder(current, context.snapshots),
          );
        }
        showToast(t("receiveOrderError"));
      },
      onSettled: (_data, error, variables, context) => {
        markReceivePending(
          receiveGroupKey(variables.orderedVia ?? null),
          false,
        );

        // Re-marked at settle for the same reason `setStatus` does: a queued
        // receive can be delivered minutes later, well past the mark
        // `onMutate` stamped, and the refetch it triggers must not light these
        // rows up as «партнёр что-то поменял» for something done here.
        if (error === null && context) {
          const now = Date.now();
          for (const snapshot of context.snapshots) {
            markOwnChange(
              ownChangesRef.current,
              snapshot.id,
              now,
              HIGHLIGHT_MS,
            );
          }
        }

        void queryClient.invalidateQueries(cartFilter);
      },
    }),
  );

  /**
   * `orderedVia` is a concrete service, never `null` — the receive bar only
   * ever renders a button for a group `receivableServiceGroups` kept, and
   * that function's whole job is dropping the one group (`null`, "ordered
   * with no service recorded") a bulk receive cannot be safely scoped to on
   * its own. Typed narrowly here so a future call site cannot reintroduce
   * that bug by accident.
   */
  function handleReceiveOrder(orderedVia: OrderedVia) {
    const key = receiveGroupKey(orderedVia);
    if (receivePendingRef.current.has(key)) {
      return;
    }
    markReceivePending(key, true);
    receiveOrder.mutate({ orderedVia });
  }

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
   *
   * The lock is a **ref**, for the same reason the checkbox's is, and it
   * matters more here: `add.isPending` and a `disabled` attribute both only
   * take effect on the next render, so two taps in one event-loop turn would
   * both get through — and `cart.add` **merges**, so two adds of «2 шт» leave
   * 4 in the cart with nothing on screen admitting the second tap did
   * anything. Both entry points (S4 and the restore confirmation) go through
   * here, so one lock covers both.
   */
  const addBusyRef = useRef(false);

  async function submitAdd(selection: ProductSelection, restore: boolean) {
    if (addBusyRef.current) {
      return;
    }
    addBusyRef.current = true;

    try {
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
        showToast(toastFor(action.toastKey, selection));
      }
    } finally {
      addBusyRef.current = false;
    }
  }

  async function confirmRestore(selection: ProductSelection) {
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

  /** Rows whose change is sitting in the offline queue — mockup 1c's 🕐. */
  const queuedIds = useQueuedCartRows(trpc.cart.pathKey());

  /**
   * Distinct services among the currently-ordered rows — the receive bar.
   * `receivableServiceGroups` drops a row group with no service recorded:
   * `cart.receiveOrder({ orderedVia: null })` means "every service" to the
   * router, not "only the service-less ones", so a button for that group
   * would risk marking Wolt/Carrefour rows bought too. Such a row cannot
   * arise from this app's own writes today (`CartItemSheet` always supplies
   * a service together with the `ordered` transition) — the checkbox still
   * buys it individually regardless.
   */
  const orderedGroups = receivableServiceGroups(groupOrderedByService(items));

  // The household's members, for the row sheet's «кто берёт» chips. Prefetched
  // server-side alongside `cart.list`/`category.list` (`page.tsx`), so this is
  // warm on first paint rather than a second client round trip.
  const household = useQuery(trpc.household.current.queryOptions());
  const members: readonly CartItemSheetMember[] = (
    household.data?.members ?? []
  ).map((member) => ({ userId: member.userId, name: member.name }));

  // Read-only, so it is safe during render: `withoutOwnChanges` never touches
  // the ref's map, and marks are written and pruned in event handlers.
  const partnerChangedIds = withoutOwnChanges(
    changedIds,
    ownChangesRef.current,
    Date.now(),
  );

  function openSearch(element: HTMLElement | null) {
    addOpener.captureOpener(element);
    setFlow({ kind: "search" });
  }

  function openItemSheet(id: string, element: HTMLElement | null) {
    editOpener.captureOpener(element);
    setEditingItemId(id);
  }

  // Looked up fresh from the live list rather than captured once at open, so
  // a save inside the sheet is visible there the moment the invalidate it
  // triggers lands — see `CartItemSheet`'s own doc comment.
  const editingItem =
    editingItemId === null
      ? null
      : (items.find((item) => item.id === editingItemId) ?? null);

  /**
   * Handed to `CartItemSheet` as `onMutated`, so its own edits get the same
   * own-change suppression `setStatus` gives the checkbox — without it, a
   * note or a buyer set from the sheet would flash as «партнёр что-то
   * поменял» the moment the sheet's own invalidate refetches the list.
   */
  function markSheetChange(rowId: string) {
    markOwnChange(ownChangesRef.current, rowId, Date.now(), HIGHLIGHT_MS);
  }

  return (
    <section className={styles.screen}>
      {/* Mockup 1c: a `--null` strip flush under the household header. Its
          promise («изменения сохранятся») is the queue's: a tap made from
          here is written to IndexedDB as soon as it is dispatched, and again
          when the page is hidden, so it survives iOS killing the PWA and is
          delivered when the connection returns (`src/trpc/offline-queue.ts`).
          What it does not promise is instant durability — the write is one
          async hop away, so a kill inside that hop still loses the tap. */}
      {isOnline ? null : (
        <p className={styles.offlineBanner} role="status">
          {t("offlineBanner")}
        </p>
      )}

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
          // Also while a write of ours is out: a manual refetch dispatched
          // then would answer with the pre-write list, for the same reason
          // the passive triggers are muted above. And while offline, where
          // the refetch would not fail but *pause* — leaving the control
          // spinning until the connection came back, promising a check it
          // cannot make. The banner above already says why.
          disabled={isRefreshing || cartMutating || !isOnline}
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

      {/* «Заказ получен» (task 2.5) — one control per delivery service that
          currently has an ordered line, directly above the first section. */}
      {orderedGroups.length === 0 ? null : (
        <div className={styles.receiveBar}>
          {orderedGroups.map((group) => {
            const key = receiveGroupKey(group.orderedVia);
            const label =
              group.orderedVia === "wolt" || group.orderedVia === "carrefour"
                ? t("receiveOrderService", {
                    service: t(`orderedService.${group.orderedVia}`),
                    count: group.count,
                  })
                : t("receiveOrder", { count: group.count });
            const pending = receivePendingKeys.has(key);

            return (
              <button
                key={key}
                type="button"
                className={styles.receiveButton}
                disabled={pending}
                onClick={() => handleReceiveOrder(group.orderedVia)}
              >
                {pending ? t("receiveOrderPending") : label}
              </button>
            );
          })}
        </div>
      )}

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
              const ordered = item.status === "ordered";
              const pending = pendingIds.has(item.id);
              // Two different cues, deliberately not one class: «ты только что
              // это сделал» carries mockup #1h's inset accent edge, «партнёр
              // что-то поменял» is 1b's plain wash. Own action wins when both
              // would apply.
              const acted = highlight?.id === item.id;
              const badgeLabel = !ordered
                ? null
                : item.orderedVia === "wolt" || item.orderedVia === "carrefour"
                  ? t("orderedBadgeService", {
                      service: t(`orderedService.${item.orderedVia}`),
                    })
                  : t("orderedBadge");

              return (
                <li key={item.id}>
                  <div
                    className={cx(
                      styles.row,
                      bought && styles.rowBought,
                      acted
                        ? styles.rowActed
                        : partnerChangedIds.has(item.id) && styles.rowChanged,
                    )}
                  >
                    {/* A dedicated hit area, deliberately separate from the
                        row body below: this is the only thing left that
                        toggles the checkbox — everything else opens the
                        action sheet (task 2.5). */}
                    <label className={styles.checkboxTarget}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={bought}
                        // Never `disabled`: the browser drops focus off a
                        // control that becomes disabled, so every keyboard
                        // toggle would throw the user back to the top of the
                        // page. The synchronous ref lock in `toggleStatus` is
                        // what actually prevents the second fire; these two
                        // only expose that state.
                        aria-disabled={pending || undefined}
                        aria-busy={pending || undefined}
                        data-pending={pending || undefined}
                        aria-label={t("rowCheckboxAria", {
                          name: item.productName,
                          qty: item.qty,
                          unit: item.unit,
                        })}
                        onChange={() => toggleStatus(item)}
                      />
                      <span className={styles.checkboxMark} aria-hidden="true">
                        ✓
                      </span>
                    </label>

                    {/* No explicit `aria-label`, deliberately: an
                        `aria-label` on a button replaces its whole
                        accessible name, descendants included — a screen
                        reader would then hear only «Изменить «Помидоры»» and
                        never the note, badge, queued mark, quantity or
                        buyer that follow. Left to compute from content, the
                        name picks up all of it — the icon span stays
                        `aria-hidden`, and the buyer avatar's own `aria-label`
                        (a `role="img"` descendant) still contributes its
                        text to that computation. */}
                    <button
                      type="button"
                      className={styles.rowBody}
                      onClick={(event) =>
                        openItemSheet(item.id, event.currentTarget)
                      }
                    >
                      <span className={styles.rowIcon} aria-hidden="true">
                        {item.productIcon}
                      </span>
                      <span
                        className={cx(
                          styles.rowName,
                          ordered && styles.rowNameOrdered,
                        )}
                      >
                        {item.productName}
                        {item.note === null ? null : (
                          <span className={styles.rowNote}>
                            {t("noteInline", { note: item.note })}
                          </span>
                        )}
                      </span>
                      {badgeLabel === null ? null : (
                        <span className={styles.rowBadge}>{badgeLabel}</span>
                      )}
                      {/* Mockup 1c puts the mark between the name and the
                          quantity, and gives it a `title` — so it names itself
                          to a mouse as well as to a screen reader. */}
                      {queuedIds.has(item.id) ? (
                        <span
                          className={styles.rowQueued}
                          role="img"
                          aria-label={t("queued")}
                          title={t("queued")}
                        >
                          🕐
                        </span>
                      ) : null}
                      <span
                        className={cx(
                          styles.rowQty,
                          ordered && styles.rowQtyPushed,
                        )}
                      >
                        {t("qtyValue", { qty: item.qty, unit: item.unit })}
                      </span>
                      {item.buyerId === null ||
                      item.buyerName === null ? null : (
                        <span
                          className={styles.rowAvatar}
                          role="img"
                          aria-label={t("buyerAvatarAria", {
                            name: item.buyerName,
                          })}
                        >
                          {avatarInitial(item.buyerName)}
                        </span>
                      )}
                    </button>
                  </div>
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

      {/* The live region is mounted for the life of the screen and only its
          text changes. A `role="status"` node that appears together with its
          content is not reliably announced — assistive technology has to have
          been watching the region *before* the text arrived. The visible card
          below is therefore presentation only. */}
      <p className={styles.srOnly} role="status">
        {toast?.message ?? ""}
      </p>

      {toast === null ? null : (
        <p className={styles.toast} aria-hidden="true">
          {toast.message}
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

      <CartItemSheet
        open={editingItemId !== null}
        onClose={() => setEditingItemId(null)}
        restoreFocusTo={editOpener.restoreFocusTo}
        item={editingItem}
        members={members}
        onMutated={markSheetChange}
      />
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
