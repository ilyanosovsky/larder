"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { DishForm } from "@/components/dish-form";
import { emptyDraft } from "@/lib/recipes/draft";

import styles from "./new-dish-screen.module.css";

/**
 * The manual-create screen. It owns nothing but the heading — every field,
 * every rule and the save itself live in `DishForm`, which is the same
 * component the edit route and (task 4.3) the import review render.
 *
 * The draft is built **once**, in a `useState` initializer: `emptyDraft()`
 * returns a fresh object each call, and a new one on every render would reset
 * nothing (the form seeds itself once) but would keep handing React a changed
 * prop for no reason.
 */
export function NewDishScreen() {
  const t = useTranslations("dishForm");
  const [initial] = useState(() => emptyDraft());

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <Link className={styles.back} href="/dishes">
          {t("back")}
        </Link>
        <h1 className={styles.title}>{t("createTitle")}</h1>
      </div>

      <DishForm initial={initial} target={{ mode: "create" }} />
    </section>
  );
}
