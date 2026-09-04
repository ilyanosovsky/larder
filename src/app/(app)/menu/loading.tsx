import { getTranslations } from "next-intl/server";

import { MenuSkeleton } from "./menu-screen";
import styles from "./menu-screen.module.css";

/**
 * S10's pending state — the same skeleton rows `MenuScreen` renders while
 * `menu.current` is in flight, shown while the page's own two prefetches run
 * (`HydrateClient` awaits them before dehydrating, see
 * `src/trpc/settle-queries.ts`).
 *
 * The rows sit under the chrome the real screen puts above them, so the pool
 * does not shift down when the data lands. As on S3 and S6, nothing here is
 * focusable: «Обновить» is an inert stand-in for its real counterpart. The
 * week range and the item count are left out — both are unknown until the
 * data exists, and neither changes the toolbar's height.
 *
 * **This file covers the whole `menu` segment**, which is exactly what it is
 * for: `/menu` is the only route under it, and without a boundary of its own
 * the tab tap would fall back to whatever an ancestor segment offers.
 */
export default async function MenuLoading() {
  const t = await getTranslations("menu");

  return (
    <section className={styles.screen}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t("title")}</h1>
        <span className={styles.refreshButton} aria-hidden="true">
          <span className={styles.refreshIcon}>⟳</span>
        </span>
      </div>

      <MenuSkeleton label={t("loading")} />
    </section>
  );
}
