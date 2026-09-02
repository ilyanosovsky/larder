"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { cx } from "@/lib/cx";
import type { EquipmentSlug } from "@/server/kitchen/equipment";
import { missingEquipment } from "@/server/recipes/equipment-check";

import styles from "./equipment-banner.module.css";

/**
 * S7's «Нужно: духовка ✓» plaque (DESIGN_BRIEF S7, mockup #1n) — whether the
 * household's own kitchen profile covers what this recipe asks for.
 *
 * Five states, in the order they are decided:
 *
 * 1. **The recipe needs nothing** (`required` empty) — renders nothing. Most
 *    dishes have no `equipment` at all; a banner that only ever said «Нужно:
 *    (ничего)» would be noise on every one of them.
 * 2. **The profile is still loading** (`profileEquipment === undefined`) —
 *    renders nothing rather than flashing «профиль не заполнен» for the
 *    instant before it turns out the household has one after all.
 *    `[dishId]/page.tsx` prefetches `kitchenProfile.get` alongside `dish.get`,
 *    but `prefetch()` is fire-and-forget, so the two can still resolve on the
 *    client a beat apart.
 * 3. **No kitchen profile has ever been saved** (`profileEquipment === null`,
 *    distinct from an empty array) — there is nothing to compare against, so
 *    the banner says so and links to where one gets set, rather than
 *    confidently reporting every requirement missing.
 * 4. **Covered** — every required slug lists with a ✓; the green family the
 *    mockup itself uses.
 * 5. **Something is missing** — the same list, now with a ✗ on the slugs the
 *    profile does not answer for, plus the `aria-disabled` «Адаптировать
 *    (ИИ)» button task 4.6 wires up.
 *
 * `missingEquipment` runs the household's profile through
 * `coerceEquipmentSlug` (task 4.5's own `src/server/recipes/equipment-check
 * .ts`), so a free-form profile entry — «мультиварка» typed into the "add
 * your own" field instead of a checked box — still counts.
 *
 * Presentational, like `QtyStepper` and `PortionsSlider`: every string
 * arrives already translated (`labels` mirrors `resolveEquipmentEntry`'s own
 * `Readonly<Record<EquipmentSlug, string>>` shape), so the screen keeps the
 * one place `dishPortions` copy is composed.
 */
export function EquipmentBanner({
  required,
  profileEquipment,
  labels,
  needLabel,
  adaptLabel,
  adaptHint,
  adaptSoonText,
  profileMissingText,
  settingsLinkLabel,
}: {
  /** `recipe.equipment`, coerced to preset slugs — see `dish-screen.tsx`. */
  required: readonly EquipmentSlug[];
  /**
   * `kitchenProfile.get`'s own `equipment` array; `null` when the household
   * has never saved one (distinct from an empty array, which means a profile
   * exists and simply lists no appliances); `undefined` while that query is
   * still in flight, rendered as nothing rather than a flash of «профиль не
   * заполнен» that a moment later turns out to be wrong.
   */
  profileEquipment: readonly string[] | null | undefined;
  labels: Readonly<Record<EquipmentSlug, string>>;
  /** «Нужно:» */
  needLabel: string;
  /** «Адаптировать (ИИ)» */
  adaptLabel: string;
  /** The caption shown beside the button while something is missing. */
  adaptHint: string;
  /** «„Адаптировать (ИИ)“ — скоро», announced (not shown) on tap. */
  adaptSoonText: string;
  profileMissingText: string;
  settingsLinkLabel: string;
}) {
  /** Spoken only: the button stays visibly `aria-disabled` either way. */
  const [announced, setAnnounced] = useState<{
    text: string;
    seq: number;
  } | null>(null);
  const announceSeq = useRef(0);

  function announceSoon() {
    announceSeq.current += 1;
    setAnnounced({ text: adaptSoonText, seq: announceSeq.current });
  }

  if (required.length === 0) {
    return null;
  }

  if (profileEquipment === undefined) {
    return null;
  }

  if (profileEquipment === null) {
    return (
      <p className={styles.profileMissing}>
        {profileMissingText}{" "}
        <Link href="/settings" className={styles.link}>
          {settingsLinkLabel}
        </Link>
      </p>
    );
  }

  const missing = missingEquipment(required, profileEquipment);
  const missingSlugs = new Set(missing);
  const covered = missing.length === 0;

  const list = required
    .map((slug) => `${labels[slug]} ${missingSlugs.has(slug) ? "✗" : "✓"}`)
    .join(" · ");

  return (
    <div
      className={cx(styles.banner, covered ? styles.covered : styles.missing)}
    >
      <span>
        {needLabel} {list}
      </span>

      {covered ? null : (
        <>
          <span className={styles.hint}>{adaptHint}</span>
          <button
            type="button"
            className={styles.adaptButton}
            aria-disabled="true"
            onClick={announceSoon}
          >
            {adaptLabel}
          </button>
        </>
      )}

      {/* The banner's own live region — never the screen's global hint
          slot, which is reserved for the four disabled screen-level actions
          (see `dish-screen.tsx`'s doc comment). */}
      <p className={styles.srOnly} role="status">
        <span key={announced?.seq ?? "empty"}>{announced?.text ?? ""}</span>
      </p>
    </div>
  );
}
