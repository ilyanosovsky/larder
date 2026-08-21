"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { cx } from "@/lib/cx";
import { ORDERED_VIA_OPTIONS, type OrderedVia } from "@/lib/ordered-via";
import type { Unit } from "@/lib/units";
import type { CartListItemOutput } from "@/server/api/routers/cart";
import { useTRPC } from "@/trpc/client";

import { BottomSheet } from "./bottom-sheet";
import styles from "./cart-item-sheet.module.css";
import { QtyStepper } from "./qty-stepper";

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
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Closed whenever there is no row to show — including the rare instant a
  // refetch removes the row out from under an open sheet (a partner deleted
  // it, say). No effect is needed to make that happen: `BottomSheet` itself
  // renders nothing while `open` is false, and `editingItemId` staying set
  // in the caller is harmless — a removed row's id can never reappear (a new
  // `cart.add` always mints a fresh one), so there is nothing for it to point
  // back at by mistake.
  const sheetOpen = open && item !== null;

  useEffect(() => {
    if (sheetOpen && item) {
      setQty(item.qty);
      setUnit(item.unit);
      setNote(item.note ?? "");
      setError(null);
    }
  }, [sheetOpen, item]);

  const updateItem = useMutation(trpc.cart.updateItem.mutationOptions());
  const setStatus = useMutation(trpc.cart.setStatus.mutationOptions());
  const remove = useMutation(trpc.cart.remove.mutationOptions());

  /**
   * Runs one action behind the shared ref lock, invalidates `cart.list` on
   * success, and reports the given message on failure. `onSuccess` is a
   * courtesy for `remove` (which also closes the sheet) — every other action
   * simply lets the fresh `item` prop show the result in place.
   */
  async function run(
    action: () => Promise<unknown>,
    errorMessage: string,
    onSuccess?: () => void,
  ) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      await action();
      void queryClient.invalidateQueries(trpc.cart.pathFilter());
      onSuccess?.();
    } catch {
      setError(errorMessage);
    } finally {
      busyRef.current = false;
      setBusy(false);
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

          <div className={styles.section}>
            <span className={styles.sectionLabel}>{t("editQtyLabel")}</span>
            <QtyStepper
              qty={qty}
              unit={unit}
              onQtyChange={setQty}
              onUnitChange={setUnit}
              decreaseAria={t("editQtyDecreaseAria")}
              increaseAria={t("editQtyIncreaseAria")}
              unitLabel={t("editUnitLabel")}
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
              onClick={() =>
                void run(
                  () =>
                    updateItem.mutateAsync({
                      id: item.id,
                      qty,
                      unit,
                      note: note.trim() === "" ? null : note.trim(),
                    }),
                  t("editSaveError"),
                )
              }
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
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      updateItem.mutateAsync({ id: item.id, buyerId: null }),
                    t("buyerError"),
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
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        updateItem.mutateAsync({
                          id: item.id,
                          buyerId: member.userId,
                        }),
                      t("buyerError"),
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
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => setOrderedVia(item, service),
                        t("orderedError"),
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
