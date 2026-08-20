"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { AutocompleteSheet } from "@/components/autocomplete-sheet";
import { BottomSheet } from "@/components/bottom-sheet";
import { ProductEditForm } from "@/components/product-edit-form";
import { groupProductsByCategory } from "@/lib/group-products";
import type { ProductListItemOutput } from "@/server/api/routers/product";
import { useTRPC } from "@/trpc/client";

import styles from "./catalog-screen.module.css";

/** How long the «В каталоге: …» confirmation stays up. */
const TOAST_MS = 2500;

/**
 * The household catalog, grouped by store department (CategorySection,
 * DESIGN_BRIEF §3) — a deliberately lean stand-in for S3 «Корзина», which
 * replaces it in task 2.3.
 *
 * What it does carry is the point of task 1.3: the FAB opens S4, and anything
 * added there lands here under its department. Tapping a row opens the same
 * «изменить продукт» form the sheet uses, because an AI-picked icon has to be
 * one tap from correctable wherever you meet it.
 */
export function CatalogScreen() {
  const t = useTranslations("catalog");
  const tCommon = useTranslations("common");
  const tEdit = useTranslations("productEdit");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ProductListItemOutput | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const products = useQuery(trpc.product.list.queryOptions());

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function refreshCatalog() {
    void queryClient.invalidateQueries(trpc.product.list.queryFilter());
  }

  const sections = groupProductsByCategory(products.data ?? []);

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t("title")}</h1>
        <p className={styles.subtitle}>{t("subtitle")}</p>
      </header>

      {products.isPending ? (
        <p className={styles.pending} role="status">
          {t("loading")}
        </p>
      ) : null}

      {products.isError ? (
        <p className={styles.error} role="alert">
          {t("loadFailed")}
        </p>
      ) : null}

      {products.isSuccess && sections.length === 0 ? (
        <p className={styles.empty}>{t("empty")}</p>
      ) : null}

      {sections.map((section) => (
        <div key={section.categoryId} className={styles.section}>
          <h2 className={styles.sectionHeader}>
            <span aria-hidden="true">{section.icon}</span>
            <span className={styles.sectionName}>{section.name}</span>
            <span className={styles.sectionCount}>
              {t("count", { count: section.items.length })}
            </span>
          </h2>

          <ul className={styles.rows}>
            {section.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => setEditing(item)}
                  aria-label={t("editAria", { name: item.name })}
                >
                  <span className={styles.rowIcon} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className={styles.rowName}>{item.name}</span>
                  <span className={styles.rowUnit}>{item.defaultUnit}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <button
        type="button"
        className={styles.fab}
        onClick={() => setSheetOpen(true)}
        aria-label={t("addAria")}
      >
        + {t("add")}
      </button>

      {toast === null ? null : (
        <p className={styles.toast} role="status">
          {toast}
        </p>
      )}

      <AutocompleteSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdded={(product) => {
          // TODO(2.3): this is where the product joins the cart. Until the
          // cart exists, landing in the catalog is the whole outcome.
          setToast(t("added", { icon: product.icon, name: product.name }));
          refreshCatalog();
        }}
      />

      <BottomSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={tEdit("title")}
        closeLabel={tCommon("close")}
      >
        {editing === null ? null : (
          <ProductEditForm
            product={editing}
            onSaved={() => {
              setEditing(null);
              refreshCatalog();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </BottomSheet>
    </section>
  );
}
