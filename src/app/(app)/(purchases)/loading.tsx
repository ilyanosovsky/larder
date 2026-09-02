import { getTranslations } from "next-intl/server";

import { cx } from "@/lib/cx";

import { CartSkeleton } from "../cart-screen";
import cartStyles from "../cart-screen.module.css";
import purchasesStyles from "../purchases-screen.module.css";

/**
 * The pending state of the «Покупки» tab (S3).
 *
 * `HydrateClient` awaits this page's prefetches before it dehydrates (see
 * `src/trpc/settle-queries.ts`), so the page's HTML now arrives with its rows
 * already in it — which is the point, but it also means the segment has
 * nothing to show while those queries run. This file is what Next streams in
 * the meantime: DESIGN_BRIEF §6's «первая загрузка списков — скелетоны», and
 * the instant feedback a tab tap needs, since a client-side navigation would
 * otherwise sit on the previous screen until the new one's data was ready.
 *
 * It renders the screen's **own** `CartSkeleton` under the chrome that sits
 * above it in the real tree — the segment control and the cart toolbar — so
 * the rows do not shift down when the data lands. Two deliberate differences,
 * both of which cost no height: the segment control's two sides are spans
 * rather than buttons (a fallback must not hand out focusable controls that
 * do nothing), and the toolbar's item count is left out because it is unknown
 * until the list exists — the refresh control carries the row's height on its
 * own, exactly as it does in `CartScreen` before its first list arrives.
 *
 * `PurchasesScreen` opens on «Корзина» (its `tab` state defaults to
 * `"cart"`), so the cart's skeleton — not the pantry's — is the shape that
 * actually follows.
 */
export default async function PurchasesLoading() {
  const [t, tCart] = await Promise.all([
    getTranslations("purchases"),
    getTranslations("cart"),
  ]);

  return (
    <div className={purchasesStyles.wrap}>
      <div
        className={purchasesStyles.segment}
        role="group"
        aria-label={t("segmentAria")}
      >
        <span
          className={cx(
            purchasesStyles.segmentButton,
            purchasesStyles.segmentButtonActive,
          )}
        >
          {t("cart")}
        </span>
        <span className={purchasesStyles.segmentButton}>{t("pantry")}</span>
      </div>

      <section className={cartStyles.screen}>
        <div className={cartStyles.toolbar}>
          <h1 className={cartStyles.toolbarTitle}>{tCart("title")}</h1>
          <span className={cartStyles.refreshButton} aria-hidden="true">
            <span className={cartStyles.refreshIcon}>⟳</span>
          </span>
        </div>

        <CartSkeleton label={tCart("loading")} />
      </section>
    </div>
  );
}
