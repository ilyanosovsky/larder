"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { qtyForUnitChange } from "@/lib/cart/qty-step";
import { cx } from "@/lib/cx";
import { ORDERED_VIA_OPTIONS, type OrderedVia } from "@/lib/ordered-via";
import type { Unit } from "@/lib/units";
import type { CartListItemOutput } from "@/server/api/routers/cart";
import { useTRPC } from "@/trpc/client";

import { BottomSheet } from "./bottom-sheet";
import styles from "./cart-item-sheet.module.css";
import { QtyStepper, type QtyStepperHandle } from "./qty-stepper";

/** One household member, as the buyer chips need it. */
export interface CartItemSheetMember {
  userId: string;
  name: string;
}

/**
 * The S3 row action sheet (DESIGN_BRIEF §4 S3, task 2.5): everything a long
 * tap on a cart line offers besides the checkbox — qty/unit, a note, «кто
 * берёт», «заказано» and its delivery service, and «Удалить».
 *
 * Deliberately **plain mutate + invalidate**, unlike the checkbox: nothing
 * here is perf-critical the way ticking down a shelf is, so there is no
 * optimistic patch to keep in sync with a rollback. `item` is looked up fresh
 * from `cart.list`'s cache by the caller on every render (not captured once at
 * open), so a save here is visible in the sheet itself the moment the
 * invalidate lands, without closing and reopening it.
 *
 * One `busyRef` covers every action in the sheet, not one per control: a
 * person edits one field at a time here, unlike the shopping-in-progress case
 * the checkbox's per-row lock exists for, so a single lock is simpler and
 * costs nothing real.
 */
export function CartItemSheet({
  open,
  onClose,
  restoreFocusTo,
  item,
  members,
  onMutated,
}: {
  open: boolean;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  /**
   * The row being edited, fresh off `cart.list`'s cache. `null` while closed,
   * or for the rare instant a refetch removes the row out from under an open
   * sheet — handled by closing rather than rendering a sheet about nothing.
   */
  item: CartListItemOutput | null;
  members: readonly CartItemSheetMember[];
  /**
   * Marks a row as changed by this client — the sheet's half of
   * `own-changes.ts`'s contract (task 2.3/2.4). Called once when an action
   * dispatches and again when it settles successfully, mirroring
   * `setStatus`'s own double-mark in `cart-screen.tsx`: the second mark
   * covers a write queued offline and delivered minutes later, well past the
   * first mark's window. Without both, a note, buyer or service set from
   * this sheet would flash as «партнёр что-то поменял» on the very next
   * refetch of the caller's own making.
   */
  onMutated: (rowId: string) => void;
}) {
  const t = useTranslations("cart");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const noteFieldId = useId();

  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState<Unit>("шт");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  /**
   * Flushed right before «Сохранить» — see `QtyStepperHandle`'s own doc
   * comment for why `handleSave` cannot just read the `qty` state instead.
   */
  const qtyStepperRef = useRef<QtyStepperHandle>(null);

  // Closed whenever there is no row to show — including the rare instant a
  // refetch removes the row out from under an open sheet (a partner deleted
  // it, say). No effect is needed to make that happen: `BottomSheet` itself
  // renders nothing while `open` is false, and `editingItemId` staying set
  // in the caller is harmless — a removed row's id can never reappear (a new
  // `cart.add` always mints a fresh one), so there is nothing for it to point
  // back at by mistake.
  const sheetOpen = open && item !== null;
  const itemId = item?.id ?? null;

  useEffect(() => {
    if (!sheetOpen || item === null) {
      return;
    }
    // Seeded once per opened row, keyed on its *id* rather than on `item`
    // itself: task 2.2's background poll and focus refetch give every
    // `cart.list` snapshot a fresh object identity regardless of whether the
    // row actually changed, and resetting on every one of those would
    // silently overwrite a note or a qty the shopper has typed but not saved
    // yet. `item` is deliberately left out of the dependency list — the
    // effect must fire only when the *edited row* changes, not merely when
    // its object reference does.
    setQty(item.qty);
    setUnit(item.unit);
    setNote(item.note ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen, itemId]);

  /**
   * The editor's own unit select: same `qtyForUnitChange` rule the S4
   * stepper uses — a shopper-set value survives a unit change unchanged,
   * and only a line still showing its unit's own default gets swapped to
   * the new one.
   */
  function changeUnit(newUnit: Unit) {
    setQty((current) => qtyForUnitChange(current, unit, newUnit));
    setUnit(newUnit);
  }

  const updateItem = useMutation(trpc.cart.updateItem.mutationOptions());
  const setStatus = useMutation(trpc.cart.setStatus.mutationOptions());
  const remove = useMutation(trpc.cart.remove.mutationOptions());

  /**
   * Whether the sheet is waiting on a live round trip — every control
   * disables on this alone. A **paused** `updateItem`/`setStatus` is
   * deliberately excluded: both use the default `networkMode: "online"`, so
   * a write made offline pauses before its request ever leaves (task 2.4)
   * and its `mutateAsync` promise does not settle until the connection
   * returns — sometimes minutes later. Counting that as "busy" would lock
   * every control in the sheet for as long as the connection is gone, which
   * breaks the one promise the offline banner elsewhere on S3 already makes:
   * «изменения сохранятся», not «действия заблокированы».
   *
   * `remove` is **not** given the same exception. Once queued, the row is on
   * its way out entirely — the offline queue delivers concurrently, not in
   * dispatch order, so a same-row `updateItem`/`setStatus` allowed to queue
   * behind it can just as easily land *after* the delete, and `activeItemScope`
   * finds no row to act on: a NOT_FOUND for an edit the shopper has no reason
   * to think failed. Staying locked for `remove`'s whole lifetime, paused or
   * not, is what rules that race out — the same trade the S4 add flow's own
   * accepted "stays up until the connection returns" limitation already
   * makes, narrowed here to the one action that cannot share a row with
   * anything queued after it.
   */
  const busy =
    (updateItem.isPending && !updateItem.isPaused) ||
    (setStatus.isPending && !setStatus.isPaused) ||
    remove.isPending;

  /** Something is sitting in the offline queue right now — reuses S3's own «ждёт синхронизации» wording (mockup 1c) rather than inventing a second one. */
  const queued = updateItem.isPaused || setStatus.isPaused || remove.isPaused;

  useEffect(() => {
    // `remove` pausing does not release the lock — see `busy`'s own doc
    // comment for why a queued removal has to keep the whole sheet locked
    // rather than just itself.
    if (remove.isPending) {
      return;
    }
    // Released the moment `updateItem`/`setStatus` pauses, not held for
    // however long it then sits in the queue. Safe for these two in a way it
    // is not for `remove`: both are last-write-wins on a row that still
    // exists, never merging like `cart.add`, so a second tap queuing a newer
    // edit behind an already-paused one is an ordinary conflict the queue
    // already resolves, not a way to corrupt anything. `busyRef`'s only real
    // job here is surviving the same synchronous tick between a tap and
    // React's next render — it was never meant to survive an entire offline
    // round trip.
    if (updateItem.isPaused || setStatus.isPaused) {
      busyRef.current = false;
    }
  }, [updateItem.isPaused, setStatus.isPaused, remove.isPending]);

  /**
   * Runs one action behind the shared ref lock, invalidates `cart.list` on
   * success, and reports the given message on failure. `onSuccess` is a
   * courtesy for `remove` (which also closes the sheet) — every other action
   * simply lets the fresh `item` prop show the result in place.
   *
   * `rowId` is marked via `onMutated` **twice**: once before `action` runs
   * (the server is about to stamp `updatedAt`, and the mark has to be in
   * place before the invalidate below can trigger a refetch that diffs
   * against it) and again on success (covering a write that paused offline
   * and only actually lands, and triggers its own refetch, minutes later —
   * see the prop's own doc comment).
   */
  async function run(
    action: () => Promise<unknown>,
    errorMessage: string,
    rowId: string,
    onSuccess?: () => void,
  ) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setError(null);
    onMutated(rowId);

    try {
      await action();
      void queryClient.invalidateQueries(trpc.cart.pathFilter());
      onMutated(rowId);
      onSuccess?.();
    } catch {
      setError(errorMessage);
    } finally {
      busyRef.current = false;
    }
  }

  /**
   * Sets the delivery service: `setStatus` moves a still-`needed` line into
   * `ordered` with it, `updateItem` changes it on a line already ordered —
   * `setStatus`'s own `ordered` branch touches `orderedVia` only when given,
   * so re-tapping the same service on an already-ordered line still needs
   * `updateItem` here rather than a no-op `setStatus`.
   */
  function setOrderedVia(current: CartListItemOutput, service: OrderedVia) {
    return current.status === "ordered"
      ? updateItem.mutateAsync({ id: current.id, orderedVia: service })
      : setStatus.mutateAsync({
          id: current.id,
          status: "ordered",
          orderedVia: service,
        });
  }

  return (
    <BottomSheet
      open={sheetOpen}
      onClose={onClose}
      title={item ? `${item.productIcon} ${item.productName}` : ""}
      closeLabel={tCommon("close")}
      restoreFocusTo={restoreFocusTo}
    >
      {item === null ? null : (
        <>
          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {queued ? (
            <p className={styles.queued} role="status">
              {t("queued")}
            </p>
          ) : null}

          <div className={styles.section}>
            <span className={styles.sectionLabel}>{t("editQtyLabel")}</span>
            <QtyStepper
              ref={qtyStepperRef}
              qty={qty}
              unit={unit}
              onQtyChange={setQty}
              onUnitChange={changeUnit}
              decreaseAria={t("editQtyDecreaseAria")}
              increaseAria={t("editQtyIncreaseAria")}
              unitLabel={t("editUnitLabel")}
              qtyInputAria={t("editQtyInputAria")}
              invalidHint={t("editQtyInvalid")}
            />

            <label className={styles.sectionLabel} htmlFor={noteFieldId}>
              {t("editNoteLabel")}
            </label>
            <input
              id={noteFieldId}
              type="text"
              className={styles.noteInput}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("editNotePlaceholder")}
              maxLength={200}
            />

            <button
              type="button"
              className={styles.saveButton}
              disabled={busy}
              onClick={() => {
                // Flushes the qty field's own draft text before it is read
                // — see `qtyStepperRef`'s doc comment for why `qty` state
                // alone is not guaranteed to reflect it here yet.
                const finalQty = qtyStepperRef.current?.commitPending() ?? qty;
                void run(
                  () =>
                    updateItem.mutateAsync({
                      id: item.id,
                      qty: finalQty,
                      unit,
                      note: note.trim() === "" ? null : note.trim(),
                    }),
                  t("editSaveError"),
                  item.id,
                );
              }}
            >
              {busy ? t("editSavePending") : t("editSave")}
            </button>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>{t("buyerLabel")}</span>
            <div className={styles.chipRow}>
              <button
                type="button"
                className={cx(
                  styles.chip,
                  item.buyerId === null && styles.chipActive,
                )}
                aria-pressed={item.buyerId === null}
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      updateItem.mutateAsync({ id: item.id, buyerId: null }),
                    t("buyerError"),
                    item.id,
                  )
                }
              >
                {t("buyerNone")}
              </button>
              {members.map((member) => (
                <button
                  key={member.userId}
                  type="button"
                  className={cx(
                    styles.chip,
                    item.buyerId === member.userId && styles.chipActive,
                  )}
                  aria-pressed={item.buyerId === member.userId}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        updateItem.mutateAsync({
                          id: item.id,
                          buyerId: member.userId,
                        }),
                      t("buyerError"),
                      item.id,
                    )
                  }
                >
                  {member.name}
                </button>
              ))}
            </div>
          </div>

          {item.status === "bought" ? null : (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>{t("orderedLabel")}</span>
              <div className={styles.chipRow}>
                {ORDERED_VIA_OPTIONS.map((service) => (
                  <button
                    key={service}
                    type="button"
                    className={cx(
                      styles.chip,
                      item.status === "ordered" &&
                        item.orderedVia === service &&
                        styles.chipActive,
                    )}
                    aria-pressed={
                      item.status === "ordered" && item.orderedVia === service
                    }
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => setOrderedVia(item, service),
                        t("orderedError"),
                        item.id,
                      )
                    }
                  >
                    {t(`orderedService.${service}`)}
                  </button>
                ))}
              </div>

              {item.status === "ordered" ? (
                <button
                  type="button"
                  className={styles.revertButton}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        setStatus.mutateAsync({
                          id: item.id,
                          status: "needed",
                        }),
                      t("orderedError"),
                      item.id,
                    )
                  }
                >
                  {t("orderedRevert")}
                </button>
              ) : null}
            </div>
          )}

          <div className={styles.section}>
            <button
              type="button"
              className={styles.removeButton}
              disabled={busy}
              onClick={() =>
                void run(
                  () => remove.mutateAsync({ id: item.id }),
                  t("removeError"),
                  item.id,
                  onClose,
                )
              }
            >
              {t("remove")}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  );
}
