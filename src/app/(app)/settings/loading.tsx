import { getTranslations } from "next-intl/server";

import styles from "./settings-page.module.css";

/**
 * S12's pending state while the page's three prefetches run (`HydrateClient`
 * awaits them before dehydrating, see `src/trpc/settle-queries.ts`).
 *
 * The three sections have no skeleton components of their own — each renders a
 * one-line «Загружаем …» while its query is pending — so this fallback is that
 * same shell with that same copy, written out here rather than lifted out of
 * three client components for a fallback that has no state to share with them.
 */
export default async function SettingsLoading() {
  const t = await getTranslations("settings");

  const sections = [
    { title: t("kitchenProfileTitle"), pending: t("kitchenProfileLoading") },
    { title: t("tripHistoryTitle"), pending: t("tripHistoryLoading") },
    { title: t("dishArchiveTitle"), pending: t("dishArchiveLoading") },
  ];

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>{t("title")}</h1>

      {sections.map((section) => (
        <section key={section.title} className={styles.section}>
          <h2 className={styles.sectionTitle}>{section.title}</h2>
          <p className={styles.pending} role="status">
            {section.pending}
          </p>
        </section>
      ))}
    </div>
  );
}
