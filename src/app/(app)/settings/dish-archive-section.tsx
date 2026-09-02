"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { pickNextFocusTarget } from "@/lib/pantry/next-focus-target";
import { isConflictError } from "@/lib/trpc-errors";

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
 *
 * **Focus is rescued after the refetch, not before it.** The row's «Вернуть»
 * is `aria-disabled` rather than `disabled`, so it still holds focus when its
 * `<li>` unmounts, and a browser drops that to `<body>` — from where the next
 * Tab restarts at the top of the settings page. The neighbour is chosen while
 * the row is still mounted (`pickNextFocusTarget`, the same pure helper S5
 * uses), and the section heading is the fallback for the case that empties
 * the list entirely. Guarded on `activeElement`, so it only ever rescues.
 */
export function DishArchiveSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pendingRef = useRef<Set<string>>(new Set());
  const toastSeq = useRef(0);

  /** Every row's «Вернуть», by dish id — DOM bookkeeping, never render state. */
  const rowButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  /** The landing spot when the list empties out; programmatic focus only. */
  const sectionRef = useRef<HTMLElement>(null);
  /** Where to put focus once the refetch has redrawn the list, or `null`. */
  const focusAfterRestoreRef = useRef<string | null | undefined>(undefined);

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
      onError: async (error) => {
        // A stale `expectedVersion` — somebody else already restored or
        // re-archived this dish — is not «попробуй ещё раз»: the same token
        // would fail the same way. Refreshing the list is the answer, and
        // often removes the row the user was pressing.
        //
        // **Awaited, so the row stays pending until the refreshed list has
        // landed.** `onSettled` clears the pending id, and TanStack awaits a
        // promise returned from `onError` before running it — without the
        // await, an immediate second tap would send the same stale token.
        if (isConflictError(error)) {
          setFailure(t("dishArchiveConflict"));
          await Promise.all([
            queryClient.invalidateQueries(
              trpc.dish.listArchived.queryFilter(),
            ),
            queryClient.invalidateQueries(trpc.dish.list.queryFilter()),
          ]);
          return;
        }
        setFailure(t("dishArchiveError"));
      },
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

  /**
   * Puts focus back somewhere useful once the refetched list has rendered
   * without the restored row.
   *
   * Keyed on `archived.data`, whose identity changes on every refetch
   * (superjson mints fresh `Date`s) — that is the signal "the list on screen
   * has been redrawn". The `activeElement` check keeps it a rescue: if the
   * user has already Tabbed on, or the row somehow survived, nothing moves.
   */
  useEffect(() => {
    const target = focusAfterRestoreRef.current;
    if (target === undefined) {
      return;
    }
    focusAfterRestoreRef.current = undefined;

    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }

    const button = target === null ? undefined : rowButtonRefs.current.get(target);
    (button ?? sectionRef.current)?.focus();
  }, [archived.data]);

  function registerRowButton(id: string, element: HTMLButtonElement | null) {
    if (element) {
      rowButtonRefs.current.set(id, element);
    } else {
      rowButtonRefs.current.delete(id);
    }
  }

  function restore(dish: { id: string; title: string; version: number }) {
    if (pendingRef.current.has(dish.id)) {
      return;
    }
    setFailure(null);
    markPending(dish.id, true);
    titles.current.set(dish.id, dish.title);
    // Chosen while the row is still mounted — "next"/"previous" are relative
    // to a row that is about to disappear, so the list has to be the one that
    // still contains it. `null` means "nothing left to land on".
    focusAfterRestoreRef.current = pickNextFocusTarget(
      archived.data ?? [],
      dish.id,
    );
    unarchive.mutate({ id: dish.id, expectedVersion: dish.version });
  }

  return (
    <section
      ref={sectionRef}
      className={styles.section}
      // Programmatic-only focus target (the rescue above), so it needs a name
      // to announce when it actually receives focus — the same treatment S5's
      // screen root gets for the identical "nothing left to land on" case.
      tabIndex={-1}
      aria-label={t("dishArchiveTitle")}
    >
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
                ref={(element) => registerRowButton(dish.id, element)}
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

      {failure === null ? null : (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      {/* Mounted for the section's whole life, with a keyed child, so two
          identical confirmations still announce twice. */}
      <p className={styles.toast} role="status">
        <span key={toast?.seq ?? "empty"}>{toast?.text ?? ""}</span>
      </p>
    </section>
  );
}
