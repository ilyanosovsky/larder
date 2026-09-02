import { getTranslations } from "next-intl/server";

import formStyles from "@/components/dish-form.module.css";

import styles from "./edit-dish-screen.module.css";

/**
 * S8.3 edit — the pending state while the page's `dish.get` prefetch runs
 * (`HydrateClient` awaits it before dehydrating, see
 * `src/trpc/settle-queries.ts`).
 *
 * Without it the route inherits `dishes/[dishId]/loading.tsx`, whose
 * `DishSkeleton` is the read-only card's shape — photo block and ingredient
 * rows — not a form's. Same shell as the create route, with this screen's own
 * heading, and nothing focusable while it is on screen.
 */
export default async function EditDishLoading() {
  const t = await getTranslations("dishForm");

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <span className={styles.back}>{t("backToDish")}</span>
        <h1 className={styles.title}>{t("editTitle")}</h1>
      </div>

      <div className={formStyles.form} role="status" aria-label={t("loading")}>
        <div className={formStyles.input} />
        <div className={formStyles.twoUp}>
          <div className={formStyles.field}>
            <div className={formStyles.input} />
          </div>
          <div className={formStyles.field}>
            <div className={formStyles.input} />
          </div>
        </div>
        <div className={formStyles.input} />
      </div>
    </section>
  );
}
