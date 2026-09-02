"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useTRPC } from "@/trpc/client";

import styles from "./settings-page.module.css";

/** Same pacing as the other settings toasts. */
const TOAST_MS = 2500;

/**
 * S12 «Архив блюд» — the other half of «В архив» on S7 (task 4.1).
 *
 * The archive exists because a dish is never deleted: phase 5's week menus
 * name dishes, and «повторить неделю» has to keep resolving them. So a dish
 * that leaves the library has to be findable somewhere, and this is that
 * somewhere — one row per archived dish, one action each.
 *
 * **No optimistic removal.** `dish.unarchive` returns the fresh `version`,
 * both lists are invalidated on success, and the row leaves when the refetch
 * lands — a fraction of a second, with the button showing its own pending
 * state meanwhile. A list this short, edited this rarely, does not earn the
 * rollback-idempotency machinery `pantry.ranOut` needs at the shelf.
 *
 * The per-row pending mark is a synchronous ref as well as state: `isPending`
 * on the shared mutation lands a render too late to stop a double tap, and
 * two «Вернуть» taps on one row would send the second with a version the
 * first has already spent (a `CONFLICT` the user cannot act on).
 */
export function DishArchiveSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pendingRef = useRef<Set<string>>(new Set());
  const toastSeq = useRef(0);

  const archived = useQuery(trpc.dish.listArchived.queryOptions());

  function markPending(id: string, pending: boolean) {
    if (pending) {
      pendingRef.current.add(id);
    } else {
      pendingRef.current.delete(id);
    }
    setPendingIds(new Set(pendingRef.current));
  }

  /**
   * The tapped dish's title, by id — captured at tap time so the toast can
   * name it after the row has already left the list.
   */
  const titles = useRef<Map<string, string>>(new Map());

  const unarchive = useMutation(
    trpc.dish.unarchive.mutationOptions({
      onSuccess: (_result, variables) => {
        toastSeq.current += 1;
        setToast({
          text: t("dishArchiveRestored", {
            title: titles.current.get(variables.id) ?? "",
          }),
          seq: toastSeq.current,
        });
        void queryClient.invalidateQueries(
          trpc.dish.listArchived.queryFilter(),
        );
        void queryClient.invalidateQueries(trpc.dish.list.queryFilter());
        void queryClient.invalidateQueries(
          trpc.dish.get.queryFilter({ id: variables.id }),
        );
      },
      onError: () => setFailed(true),
      onSettled: (_result, _error, variables) => {
        markPending(variables.id, false);
        titles.current.delete(variables.id);
      },
    }),
  );

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function restore(dish: { id: string; title: string; version: number }) {
    if (pendingRef.current.has(dish.id)) {
      return;
    }
    setFailed(false);
    markPending(dish.id, true);
    titles.current.set(dish.id, dish.title);
    unarchive.mutate({ id: dish.id, expectedVersion: dish.version });
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("dishArchiveTitle")}</h2>

      {archived.isPending ? (
        <p className={styles.pending} role="status">
          {t("dishArchiveLoading")}
        </p>
      ) : archived.isError ? (
        <div className={styles.error} role="alert">
          <p>{t("dishArchiveLoadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void archived.refetch()}
          >
            {t("dishArchiveRetry")}
          </button>
        </div>
      ) : archived.data.length === 0 ? (
        <p className={styles.pending}>{t("dishArchiveEmpty")}</p>
      ) : (
        <ul className={styles.dishArchiveList}>
          {archived.data.map((dish) => (
            <li key={dish.id} className={styles.dishArchiveRow}>
              <span className={styles.dishArchiveName}>{dish.title}</span>
              <button
                type="button"
                className={styles.dishArchiveButton}
                aria-disabled={pendingIds.has(dish.id) || undefined}
                aria-label={t("dishArchiveRestoreAria", { title: dish.title })}
                onClick={() => restore(dish)}
              >
                {t("dishArchiveRestore")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {failed ? (
        <p className={styles.error} role="alert">
          {t("dishArchiveError")}
        </p>
      ) : null}

      {/* Mounted for the section's whole life, with a keyed child, so two
          identical confirmations still announce twice. */}
      <p className={styles.toast} role="status">
        <span key={toast?.seq ?? "empty"}>{toast?.text ?? ""}</span>
      </p>
    </section>
  );
}
