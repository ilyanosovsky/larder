import { getTranslations } from "next-intl/server";

import formStyles from "@/components/dish-form.module.css";

import styles from "./new-dish-screen.module.css";

/**
 * S8.3 create — the pending state of «✍️ Вручную».
 *
 * The route prefetches nothing (a blank form has no server state), so this
 * fallback only ever covers the RSC round trip after the tap. It exists
 * because the alternative is worse: without it the route inherits
 * `dishes/loading.tsx`, and the S6 tile grid — the screen the person is
 * leaving — would flash in place of the form they asked for.
 *
 * Heading and first fields only, in the form's own classes: enough to hold
 * the shape for one round trip, and nothing focusable, since a fallback's
 * controls do nothing.
 */
export default async function NewDishLoading() {
  const t = await getTranslations("dishForm");

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <span className={styles.back}>{t("back")}</span>
        <h1 className={styles.title}>{t("createTitle")}</h1>
      </div>

      <div
        className={formStyles.form}
        role="status"
        aria-label={t("formLoading")}
      >
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
