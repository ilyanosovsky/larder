"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  KitchenProfileForm,
  type KitchenProfileFormValue,
} from "@/components/kitchen-profile-form";
import { HOME_PATH } from "@/lib/auth-redirect";
import type { KitchenProfileOutput } from "@/server/api/routers/kitchen-profile";
import { useTRPC } from "@/trpc/client";

import styles from "./kitchen-onboarding-screen.module.css";

/** VISION §5: our own starting profile, before anyone has ticked a box. */
const DEFAULT_VALUE: KitchenProfileFormValue = {
  householdSize: 2,
  equipment: [],
};

/**
 * S2 kitchen-profile step (DESIGN_BRIEF §4 S2): the checklist + headcount,
 * reached after a household exists. Skippable — both "Done" and "Skip" land
 * on the cart, the only difference is whether the profile got saved first.
 */
export function KitchenOnboardingScreen({
  initialProfile,
}: {
  /**
   * From `kitchenProfile.get`, read server-side by the page. `null` means
   * nobody has saved one yet, so the form starts from `DEFAULT_VALUE`. A
   * non-null value means the household's creator (or an earlier pass
   * through this step) already saved one — the partner accepting an invite
   * lands here next and must see it prefilled, not blow it away with a
   * blank form's defaults on submit.
   */
  initialProfile: KitchenProfileOutput | null;
}) {
  const t = useTranslations("onboardingKitchen");
  const trpc = useTRPC();
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  const update = useMutation(trpc.kitchenProfile.update.mutationOptions());
  const initialValue = initialProfile ?? DEFAULT_VALUE;

  async function save(value: KitchenProfileFormValue) {
    setFailed(false);

    try {
      await update.mutateAsync(value);
      router.push(HOME_PATH);
    } catch {
      setFailed(true);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t("title")}</h1>
        <p className={styles.subtitle}>{t("subtitle")}</p>

        <div className={styles.formWrap}>
          <KitchenProfileForm
            initialValue={initialValue}
            onSubmit={(value) => void save(value)}
            pending={update.isPending}
            submitLabel={update.isPending ? t("savePending") : t("save")}
          />
        </div>

        {failed ? (
          <p className={styles.error} role="alert">
            {t("error")}
          </p>
        ) : null}

        <Link className={styles.skipLink} href={HOME_PATH}>
          {t("skip")}
        </Link>
      </div>
    </main>
  );
}
