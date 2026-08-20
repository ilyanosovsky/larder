"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  EQUIPMENT_PRESETS,
  normalizeEquipment,
  type EquipmentSlug,
} from "@/server/kitchen/equipment";

import styles from "./kitchen-profile-form.module.css";

const MIN_HOUSEHOLD_SIZE = 1;
const MAX_HOUSEHOLD_SIZE = 10;

const PRESET_SET: ReadonlySet<string> = new Set(EQUIPMENT_PRESETS);

export interface KitchenProfileFormValue {
  householdSize: number;
  equipment: string[];
}

/**
 * «Профиль кухни»: the equipment checklist + free-form input + household
 * size stepper (VISION §3.3, §5; DESIGN_BRIEF S2 «шаг „Профиль кухни“», S12
 * settings section) — shared between the two so they can never drift.
 *
 * Deliberately owns no mutation: the caller passes `pending` back in and
 * gets a value on `onSubmit`, so this stays a plain controlled form the S2
 * step and the S12 section can each wire to their own `kitchenProfile.update`
 * call and their own success/error handling.
 */
export function KitchenProfileForm({
  initialValue,
  onSubmit,
  pending,
  submitLabel,
}: {
  initialValue: KitchenProfileFormValue;
  onSubmit: (value: KitchenProfileFormValue) => void;
  pending: boolean;
  submitLabel: string;
}) {
  const t = useTranslations("kitchenProfile");
  const customFieldId = useId();

  const [householdSize, setHouseholdSize] = useState(
    initialValue.householdSize,
  );
  const [equipment, setEquipment] = useState(initialValue.equipment);
  const [customInput, setCustomInput] = useState("");

  // Anything in `equipment` that is not one of the checklist slugs is a
  // free-form entry someone typed — rendered as a removable chip instead of
  // a checkbox.
  const customItems = equipment.filter((item) => !PRESET_SET.has(item));

  function togglePreset(slug: EquipmentSlug) {
    setEquipment((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : normalizeEquipment([...current, slug]),
    );
  }

  function addCustom() {
    const value = customInput.trim();
    if (value.length === 0) {
      return;
    }
    setEquipment((current) => normalizeEquipment([...current, value]));
    setCustomInput("");
  }

  function removeCustom(value: string) {
    setEquipment((current) => current.filter((item) => item !== value));
  }

  function onCustomKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }
    // A bare Enter must add the chip, not submit the whole form — the
    // stepper and the checklist above are still there to fill in.
    event.preventDefault();
    addCustom();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    onSubmit({ householdSize, equipment });
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <fieldset className={styles.checklist}>
        <legend className={styles.legend}>{t("equipmentLegend")}</legend>
        {EQUIPMENT_PRESETS.map((slug) => (
          <label key={slug} className={styles.checkRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={equipment.includes(slug)}
              onChange={() => togglePreset(slug)}
            />
            <span>{t(`equipment.${slug}`)}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.customBlock}>
        <label className={styles.label} htmlFor={customFieldId}>
          {t("customLabel")}
        </label>
        <div className={styles.customRow}>
          <input
            id={customFieldId}
            className={styles.customInput}
            type="text"
            value={customInput}
            onChange={(event) => setCustomInput(event.target.value)}
            onKeyDown={onCustomKeyDown}
            maxLength={40}
            placeholder={t("customPlaceholder")}
            autoComplete="off"
          />
          <button
            type="button"
            className={styles.addButton}
            onClick={addCustom}
            disabled={customInput.trim().length === 0}
          >
            {t("customAdd")}
          </button>
        </div>

        {customItems.length > 0 ? (
          <ul className={styles.chipList}>
            {customItems.map((item) => (
              <li key={item} className={styles.chip}>
                <span>{item}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => removeCustom(item)}
                  aria-label={t("customRemoveAria", { name: item })}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className={styles.stepperBlock}>
        <span className={styles.label}>{t("householdSizeLabel")}</span>
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.stepperButton}
            onClick={() =>
              setHouseholdSize((size) => Math.max(MIN_HOUSEHOLD_SIZE, size - 1))
            }
            disabled={householdSize <= MIN_HOUSEHOLD_SIZE}
            aria-label={t("decreaseAria")}
          >
            −
          </button>
          <span className={styles.stepperValue}>{householdSize}</span>
          <button
            type="button"
            className={styles.stepperButton}
            onClick={() =>
              setHouseholdSize((size) => Math.min(MAX_HOUSEHOLD_SIZE, size + 1))
            }
            disabled={householdSize >= MAX_HOUSEHOLD_SIZE}
            aria-label={t("increaseAria")}
          >
            +
          </button>
        </div>
      </div>

      <button type="submit" className={styles.primaryButton} disabled={pending}>
        {submitLabel}
      </button>
    </form>
  );
}
