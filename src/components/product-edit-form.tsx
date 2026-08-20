"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { isConflictError } from "@/lib/trpc-errors";
import { UNITS, type Unit } from "@/lib/units";
import type { ProductOutput } from "@/server/api/routers/product";
import { useTRPC } from "@/trpc/client";

import styles from "./product-edit-form.module.css";

/** Everything this form can change — the shape both callers already hold. */
export type EditableProduct = Pick<
  ProductOutput,
  "id" | "name" | "icon" | "categoryId" | "defaultUnit"
>;

/**
 * «Изменить продукт»: emoji, name, department, default unit
 * (DESIGN_BRIEF S3 «мини-шит», reached from S4 right after a product is
 * created by the AI).
 *
 * This is the other half of the AI contract in VISION §3.1 — the icon and the
 * department are a *suggestion*, and everything is editable. Whatever the
 * model got wrong has to be one tap away from fixed, or the suggestion stops
 * being a help and becomes something to fight.
 */
export function ProductEditForm({
  product,
  onSaved,
  onCancel,
}: {
  product: EditableProduct;
  onSaved: (product: ProductOutput) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("productEdit");
  const trpc = useTRPC();
  const iconFieldId = useId();
  const nameFieldId = useId();
  const categoryFieldId = useId();
  const unitFieldId = useId();

  const [icon, setIcon] = useState(product.icon);
  const [name, setName] = useState(product.name);
  const [categoryId, setCategoryId] = useState(product.categoryId);
  const [unit, setUnit] = useState<Unit>(product.defaultUnit);
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery(trpc.category.list.queryOptions());
  const update = useMutation(trpc.product.update.mutationOptions());

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // `disabled={update.isPending}` on the button only takes effect on the
    // next render, so two submits in one tick would both go through. Reading
    // the mutation's state at call time closes that window.
    if (update.isPending) {
      return;
    }

    setError(null);

    try {
      const saved = await update.mutateAsync({
        id: product.id,
        name,
        icon,
        categoryId,
        defaultUnit: unit,
      });
      onSaved(saved);
    } catch (caught) {
      // A name collision is a different message from a generic failure: one
      // is fixable by editing the field in front of you, the other is not.
      setError(isConflictError(caught) ? t("conflict") : t("error"));
    }
  }

  return (
    <form className={styles.form} onSubmit={save}>
      <div className={styles.row}>
        <div className={styles.iconField}>
          <label className={styles.label} htmlFor={iconFieldId}>
            {t("iconLabel")}
          </label>
          <input
            id={iconFieldId}
            className={styles.iconInput}
            type="text"
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            maxLength={16}
            autoComplete="off"
            required
          />
        </div>

        <div className={styles.nameField}>
          <label className={styles.label} htmlFor={nameFieldId}>
            {t("nameLabel")}
          </label>
          <input
            id={nameFieldId}
            className={styles.input}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            autoComplete="off"
            required
          />
        </div>
      </div>

      <label className={styles.label} htmlFor={categoryFieldId}>
        {t("categoryLabel")}
      </label>
      <select
        id={categoryFieldId}
        className={styles.input}
        value={categoryId}
        onChange={(event) => setCategoryId(event.target.value)}
      >
        {(categories.data ?? []).map((category) => (
          <option key={category.id} value={category.id}>
            {category.icon} {category.name}
          </option>
        ))}
      </select>

      <label className={styles.label} htmlFor={unitFieldId}>
        {t("unitLabel")}
      </label>
      <select
        id={unitFieldId}
        className={styles.input}
        value={unit}
        onChange={(event) => setUnit(event.target.value as Unit)}
      >
        {UNITS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onCancel}
          disabled={update.isPending}
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={update.isPending || name.trim().length === 0}
        >
          {update.isPending ? t("savePending") : t("save")}
        </button>
      </div>
    </form>
  );
}
