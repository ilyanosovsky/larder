import { getTranslations } from "next-intl/server";

import styles from "./import-screen.module.css";

/**
 * S8.1's pending state.
 *
 * The route prefetches nothing, so this only ever covers the RSC round trip
 * after the tap. It exists because the alternative is worse: without it the
 * segment inherits `dishes/loading.tsx`, and the S6 tile grid — the screen
 * the person just left — would flash in place of the picker they asked for.
 *
 * Heading and the drop zone's shape, nothing focusable: a fallback's controls
 * do nothing, and a file input that cannot open a dialog is worse than none.
 */
export default async function ImportLoading() {
  const t = await getTranslations("dishImport");

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <span className={styles.back}>{t("back")}</span>
        <h1 className={styles.title}>{t("title")}</h1>
      </div>

      <div className={styles.source} aria-hidden="true">
        <div className={styles.photoZone}>
          <span className={styles.photoIcon}>📷</span>
          <p className={styles.photoHint}>{t("photoZoneHint")}</p>
        </div>
      </div>
    </section>
  );
}
