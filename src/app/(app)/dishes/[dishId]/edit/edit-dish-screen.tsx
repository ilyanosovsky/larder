"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { DishForm } from "@/components/dish-form";
import { DishPhotoUpload } from "@/components/dish-photo-upload";
import type { BoundProduct } from "@/components/ingredient-edit-row";
import { draftFromDetail } from "@/lib/recipes/draft";
import { trpcErrorCode } from "@/lib/trpc-errors";
import type { DishDetailOutput } from "@/server/api/routers/dish";
import { useTRPC } from "@/trpc/client";

import styles from "./edit-dish-screen.module.css";

/**
 * Loads the aggregate, seeds the form from it once, and keeps watching it.
 *
 * **The form is not remounted when the server moves on.** `dish.get` refetches
 * on focus and in the background; a `key={`${dishId}:${version}`}` would throw
 * away a half-typed recipe the moment a partner saved anything. Instead the
 * newest aggregate is handed down as `latest`, the form raises «Блюдо
 * изменили — обновить?», and the server's version replaces what is on screen
 * only when the user taps it.
 *
 * The seed itself is frozen at mount (`useState`), so even the first
 * background refetch — which produces a structurally new object every time,
 * because superjson rebuilds its `Date`s — cannot reach the fields.
 */
export function EditDishScreen({ dishId }: { dishId: string }) {
  const t = useTranslations("dishForm");
  const importCopy = useTranslations("dishImport");
  const trpc = useTRPC();
  const dish = useQuery(trpc.dish.get.queryOptions({ id: dishId }));

  const [seed, setSeed] = useState<DishDetailOutput | null>(
    () => dish.data ?? null,
  );

  // The very first successful load, and only that one: `seed` stays null until
  // the query answers, and this never fires again once it holds a value.
  if (seed === null && dish.data) {
    setSeed(dish.data);
  }

  if (seed === null) {
    if (dish.isError) {
      return (
        <p className={styles.state} role="alert">
          {trpcErrorCode(dish.error) === "NOT_FOUND"
            ? t("notFound")
            : t("loadFailed")}
        </p>
      );
    }
    return (
      <p className={styles.state} role="status">
        {t("loading")}
      </p>
    );
  }

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <Link className={styles.back} href={`/dishes/${dishId}`}>
          {t("backToDish")}
        </Link>
        <h1 className={styles.title}>{t("editTitle")}</h1>
      </div>

      <DishForm
        initial={draftFromDetail(seed)}
        target={{ mode: "edit", dishId, version: seed.version }}
        latest={
          dish.data
            ? {
                draft: draftFromDetail(dish.data),
                version: dish.data.version,
                productLabels: productLabels(dish.data),
              }
            : null
        }
        productLabels={productLabels(seed)}
        photoUploadSlot={({ current, onPicked }) => (
          <DishPhotoUpload
            label={
              current.url === null
                ? importCopy("addPhoto")
                : importCopy("replacePhoto")
            }
            busyLabel={importCopy("compressing")}
            errorLabels={{
              tooLarge: importCopy("photoTooBig"),
              notAnImage: importCopy("photoNotImage"),
              uploadFailed: importCopy("uploadFailed"),
            }}
            onPicked={onPicked}
          />
        )}
      />
    </section>
  );
}

/** What the rows are already bound to, so a bound row shows its product. */
function productLabels(detail: DishDetailOutput): Record<string, BoundProduct> {
  const labels: Record<string, BoundProduct> = {};

  for (const row of detail.ingredients) {
    if (row.productId !== null && row.productName !== null) {
      labels[row.productId] = {
        name: row.productName,
        icon: row.productIcon ?? "🛒",
      };
    }
  }

  return labels;
}
