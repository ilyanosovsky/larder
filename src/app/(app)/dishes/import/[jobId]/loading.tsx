import { getTranslations } from "next-intl/server";

import { AiProgress } from "@/components/ai-progress";

import styles from "../import-screen.module.css";

/**
 * The review route's pending state, while the page's `dishImport.getJob`
 * prefetch runs (`HydrateClient` awaits it before dehydrating — see
 * `src/trpc/settle-queries.ts`).
 *
 * Deliberately the **same AiProgress block** the screen itself shows for a
 * job that is still running, rather than a form skeleton: the person arrived
 * here straight from «Разбираю рецепт…», and a form-shaped shell that then
 * turned back into a progress block would be two shape changes for one wait.
 *
 * Without it the segment inherits `dishes/loading.tsx` and the S6 tile grid
 * would flash instead.
 */
export default async function ImportReviewLoading() {
  const t = await getTranslations("dishImport");

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <span className={styles.back}>{t("back")}</span>
        <h1 className={styles.title}>{t("reviewTitle")}</h1>
      </div>

      <AiProgress label={t("reviewLoading")} hint={t("parsingHint")} />
    </section>
  );
}
