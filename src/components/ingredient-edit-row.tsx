"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { formatQtyInput, parseQtyInput } from "@/lib/recipes/form-fields";
import { RECIPE_UNITS, type RecipeUnit } from "@/lib/units";
import type { DraftIngredient } from "@/lib/recipes/draft";
import { deriveNeedsReview } from "@/server/recipes/needs-review";

import styles from "./dish-form.module.css";
import { NeedsReviewChip } from "./needs-review-chip";

/** What the form knows about the catalog row an ingredient is bound to. */
export interface BoundProduct {
  name: string;
  icon: string;
}

/**
 * One editable ingredient of S8.3 (DESIGN_BRIEF S8.3: «ингредиенты построчно
 * — кол-во + единица + привязка к продукту каталога»).
 *
 * Three things share the row, and the design is emphatic that they must not
 * look alike (blueprint §4.6):
 *
 * - the amber «уточнить» chip — the amount is missing and nobody meant it to
 *   be. Tapping it puts the caret in the quantity field, and Enter there moves
 *   on to the unit; the chip disappears the moment `deriveNeedsReview` — the
 *   *same* function the server stores its answer from — returns false;
 * - the neutral «новый» chip — this name matches nothing in the catalog yet.
 *   No action needed: the save creates the product;
 * - «опционально», a checkbox, because it is the one flag the recipe itself
 *   states rather than something we inferred.
 *
 * The quantity is a plain text input, not `QtyStepper`: that component's floor
 * is one whole unit (`STEPPER_MIN_QTY`), and «¾ ч.л.» is typed, not stepped.
 */
export function IngredientEditRow({
  value,
  bound,
  removeButtonId,
  onChange,
  onRebind,
  onRemove,
}: {
  value: DraftIngredient;
  /** The catalog row it is bound to, when the form has been told its name. */
  bound: BoundProduct | null;
  /** So the form can move focus here after the row above it is deleted. */
  removeButtonId: string;
  onChange: (next: DraftIngredient) => void;
  /** Takes the control that opened the sheet, so focus can return to it. */
  onRebind: (opener: HTMLElement | null) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("dishForm");
  const fieldId = useId();
  const qtyRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLSelectElement>(null);

  /**
   * The quantity field holds **text**, not the formatted number.
   *
   * A controlled input over `formatQtyInput(parseQtyInput(text))` cannot be
   * typed into: «0.5» starts as «0», which is below `MIN_QTY` and therefore
   * parses to `null`, which formats back to «» — the field would empty itself
   * under the thumb before the decimal point was ever reached. The draft still
   * gets the parsed value on every keystroke, so nothing downstream sees the
   * text. Seeded once: the row remounts (a fresh list key) whenever the form
   * re-seeds, so there is no second source of truth to keep in step.
   */
  const [qtyText, setQtyText] = useState(() => formatQtyInput(value.qty));

  const needsReview = deriveNeedsReview(value);

  function patch(next: Partial<DraftIngredient>) {
    onChange({ ...value, ...next });
  }

  function onQtyKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // «уточнить» asks for two things, and this is the second one. Enter
    // rather than a blur handler: a blur that moved focus would fight every
    // attempt to leave the field for somewhere else entirely.
    if (event.key === "Enter") {
      event.preventDefault();
      unitRef.current?.focus();
    }
  }

  return (
    <li className={styles.ingredientRow}>
      <div className={styles.ingredientTop}>
        <label className={styles.srOnly} htmlFor={`${fieldId}-name`}>
          {t("ingredientName")}
        </label>
        <input
          id={`${fieldId}-name`}
          className={styles.nameInput}
          type="text"
          value={value.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder={t("ingredientNamePlaceholder")}
          maxLength={100}
          autoComplete="off"
        />

        <button
          type="button"
          className={styles.bindButton}
          onClick={(event) => onRebind(event.currentTarget)}
          aria-label={t("rebindAria", { name: value.name || t("newProduct") })}
        >
          {value.productId === null ? (
            <NeedsReviewChip label={t("newProduct")} variant="neutral" />
          ) : (
            <span className={styles.boundProduct}>
              <span aria-hidden="true">{bound?.icon ?? "🛒"}</span>
              <span className={styles.boundName}>
                {bound?.name ?? t("boundProduct")}
              </span>
            </span>
          )}
        </button>

        <button
          type="button"
          id={removeButtonId}
          className={styles.rowRemove}
          onClick={onRemove}
          aria-label={t("removeIngredientAria", {
            name: value.name || t("ingredientName"),
          })}
        >
          ✕
        </button>
      </div>

      <div className={styles.ingredientFields}>
        <label className={styles.srOnly} htmlFor={`${fieldId}-qty`}>
          {t("qtyLabel")}
        </label>
        <input
          id={`${fieldId}-qty`}
          ref={qtyRef}
          className={styles.qtyInput}
          type="text"
          inputMode="decimal"
          value={qtyText}
          onChange={(event) => {
            setQtyText(event.target.value);
            patch({ qty: parseQtyInput(event.target.value) });
          }}
          onKeyDown={onQtyKeyDown}
          placeholder={t("qtyPlaceholder")}
          autoComplete="off"
        />

        <label className={styles.srOnly} htmlFor={`${fieldId}-unit`}>
          {t("unitLabel")}
        </label>
        <select
          id={`${fieldId}-unit`}
          ref={unitRef}
          className={styles.unitSelect}
          value={value.unit ?? ""}
          onChange={(event) =>
            patch({
              unit:
                event.target.value === ""
                  ? null
                  : (event.target.value as RecipeUnit),
            })
          }
        >
          {/* A unit is a stored value rendered verbatim, never dictionary
              copy — the empty option is the only string here that is ours. */}
          <option value="">{t("unitNone")}</option>
          {RECIPE_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>

        <label className={styles.srOnly} htmlFor={`${fieldId}-note`}>
          {t("noteLabel")}
        </label>
        <input
          id={`${fieldId}-note`}
          className={styles.noteInput}
          type="text"
          value={value.note ?? ""}
          onChange={(event) =>
            patch({
              note: event.target.value.length === 0 ? null : event.target.value,
            })
          }
          placeholder={t("notePlaceholder")}
          maxLength={100}
          autoComplete="off"
        />
      </div>

      <div className={styles.ingredientFlags}>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={value.isOptional}
            onChange={(event) => patch({ isOptional: event.target.checked })}
          />
          {t("optional")}
        </label>

        {needsReview ? (
          <button
            type="button"
            className={styles.chipButton}
            onClick={() => qtyRef.current?.focus()}
          >
            <NeedsReviewChip label={t("needsReview")} />
          </button>
        ) : null}
      </div>
    </li>
  );
}
