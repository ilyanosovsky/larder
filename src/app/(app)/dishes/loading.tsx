import { getTranslations } from "next-intl/server";

import { LibrarySkeleton } from "./dish-library-screen";
import styles from "./dish-library-screen.module.css";

/**
 * S6's pending state — the same skeleton tiles `DishLibraryScreen` renders
 * while `dish.list` is in flight, shown while the page's own prefetch runs
 * (`HydrateClient` awaits it before dehydrating, see
 * `src/trpc/settle-queries.ts`).
 *
 * The tiles sit under the chrome the real screen puts above them — toolbar,
 * search field, tag row — so the grid does not shift down when the data
 * lands. As on S3, nothing here is focusable or interactive: the «+ Блюдо»
 * control and the search field are inert stand-ins for their real
 * counterparts, and the tag row holds only the «все» chip that the screen
 * always renders first when it has any tags at all. The item count is left
 * out for the same reason as on S3 — it is unknown until the list exists, and
 * the toolbar's height does not depend on it.
 */
export default async function DishesLoading() {
  const t = await getTranslations("dishes");

  return (
    <section className={styles.screen}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t("title")}</h1>
        <span className={styles.addButton} aria-hidden="true">
          {t("add")}
        </span>
      </div>

      <div className={styles.search} aria-hidden="true" />

      <div className={styles.tags} aria-hidden="true">
        <span className={styles.tag}>{t("tagAll")}</span>
      </div>

      <LibrarySkeleton label={t("loading")} />
    </section>
  );
}
