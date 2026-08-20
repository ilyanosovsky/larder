"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  KitchenProfileForm,
  type KitchenProfileFormValue,
} from "@/components/kitchen-profile-form";
import { useTRPC } from "@/trpc/client";

import styles from "./settings-page.module.css";

/** How long the save confirmation stays up — same pacing as the catalog toast. */
const TOAST_MS = 2500;

/** VISION §5: what the form starts from before a household has ever saved one. */
const DEFAULT_VALUE: KitchenProfileFormValue = {
  householdSize: 2,
  equipment: [],
};

/**
 * The S12 kitchen-profile settings section (task 1.4) — a light wrapper
 * around the shared form: reads `kitchenProfile.get` (prefetched by the
 * server component), writes through `kitchenProfile.update`, and shows a
 * toast on success. Full S12 assembly (household, invite, purchase history,
 * departments, AI budget) is task 7.1; this is only its first block.
 */
export function KitchenProfileSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const profile = useQuery(trpc.kitchenProfile.get.queryOptions());
  const update = useMutation(trpc.kitchenProfile.update.mutationOptions());

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  async function save(value: KitchenProfileFormValue) {
    setFailed(false);

    try {
      await update.mutateAsync(value);
      setToast(t("kitchenProfileSaved"));
      void queryClient.invalidateQueries(trpc.kitchenProfile.get.queryFilter());
    } catch {
      setFailed(true);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("kitchenProfileTitle")}</h2>

      {profile.isPending ? (
        <p className={styles.pending} role="status">
          {t("kitchenProfileLoading")}
        </p>
      ) : profile.isError ? (
        // A savable form must never mount on an unknown state: `data` would
        // be `undefined` here, and `profile.data ?? DEFAULT_VALUE` would
        // silently show empty defaults that the Save button then writes
        // over whatever the household's real profile actually is.
        <div className={styles.error} role="alert">
          <p>{t("kitchenProfileLoadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void profile.refetch()}
          >
            {t("kitchenProfileRetry")}
          </button>
        </div>
      ) : (
        <>
          <KitchenProfileForm
            initialValue={profile.data ?? DEFAULT_VALUE}
            onSubmit={(value) => void save(value)}
            pending={update.isPending}
            submitLabel={
              update.isPending
                ? t("kitchenProfileSavePending")
                : t("kitchenProfileSave")
            }
          />

          {failed ? (
            <p className={styles.error} role="alert">
              {t("kitchenProfileError")}
            </p>
          ) : null}
        </>
      )}

      {toast === null ? null : (
        <p className={styles.toast} role="status">
          {toast}
        </p>
      )}
    </section>
  );
}
