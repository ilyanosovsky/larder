"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { useTRPC } from "@/trpc/client";

import styles from "./settings-page.module.css";

/**
 * S12 «История закупок» (DESIGN_BRIEF S12, VISION §3.1) — the by-product of
 * «Завершить закупку»: one line per closed trip, its date and how much it
 * carried off.
 *
 * Skeleton level, like `KitchenProfileSection` next to it: DESIGN_BRIEF's
 * «строка раскрывается в список купленного» needs a per-trip read that task
 * 7.1 adds together with the rest of the full S12 assembly. `trip.list`
 * deliberately returns a count rather than the lines themselves for the same
 * reason — this block shows nothing else.
 *
 * The date is formatted through next-intl's own formatter rather than
 * `toLocaleDateString`, and that is not just idiom: this is a client
 * component, so it renders on the server too, and next-intl resolves the time
 * zone once on the server and hands the same one to the client provider. A
 * raw `Intl` call would use the server's zone during SSR and the browser's
 * after hydration — a mismatch that lands exactly on the dates near midnight.
 * No global `timeZone` is configured yet (`src/i18n/request.ts`), so dates
 * read in the deployment's zone (UTC on Vercel); pinning the household's own
 * zone is a settings question for task 7.1, not something to invent here.
 */
export function TripHistorySection() {
  const t = useTranslations("settings");
  const format = useFormatter();
  const trpc = useTRPC();

  const trips = useQuery(trpc.trip.list.queryOptions());

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("tripHistoryTitle")}</h2>

      {trips.isPending ? (
        <p className={styles.pending} role="status">
          {t("tripHistoryLoading")}
        </p>
      ) : trips.isError ? (
        <div className={styles.error} role="alert">
          <p>{t("tripHistoryLoadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void trips.refetch()}
          >
            {t("tripHistoryRetry")}
          </button>
        </div>
      ) : trips.data.length === 0 ? (
        <p className={styles.pending}>{t("tripHistoryEmpty")}</p>
      ) : (
        <ul className={styles.tripList}>
          {trips.data.map((trip) => (
            <li key={trip.id} className={styles.tripRow}>
              <time
                className={styles.tripDate}
                // The machine-readable half stays absolute (UTC), whatever
                // zone the visible text above ends up rendered in.
                dateTime={trip.closedAt.toISOString()}
              >
                {format.dateTime(trip.closedAt, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </time>
              <span className={styles.tripCount}>
                {t("tripHistoryItems", { count: trip.itemCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
