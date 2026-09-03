"use client";

import Link from "next/link";

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
 *    instant before it turns out the household has one after all. Not
 *    reachable on a cold load whose prefetches both succeeded:
 *    `[dishId]/page.tsx` prefetches `kitchenProfile.get` alongside `dish.get`
 *    and `HydrateClient` awaits both, so the two normally arrive together.
 *    Two producers remain. A `kitchenProfile.get` prefetch that errored on
 *    the server is deliberately not dehydrated (`shouldDehydrateQuery` ships
 *    successes only — see `src/trpc/server.tsx`), so the client fetches it
 *    under an already-rendered dish; and a client-side invalidate after
 *    saving the profile puts this query, and only this query, back in
 *    flight.
 * 3. **No kitchen profile has ever been saved** (`profileEquipment === null`,
 *    distinct from an empty array) — there is nothing to compare against, so
 *    the banner says so and links to where one gets set, rather than
 *    confidently reporting every requirement missing.
 * 4. **Covered** — every required slug lists with a ✓; the green family the
 *    mockup itself uses.
 * 5. **Something is missing** — the same ✓/✗ list, plus a plain-words
 *    «Не хватает: …» sentence naming the missing appliances (never a bare
 *    glyph as the only carrier of that fact — see the a11y note below), an
 *    explanatory caption, and the «Адаптировать (ИИ)» button — a real
 *    control since task 4.6, which opens the proposal sheet.
 *
 * `missingEquipment` runs the household's profile through
 * `coerceEquipmentSlug` (task 4.5's own `src/server/recipes/equipment-check
 * .ts`), so a free-form profile entry — «мультиварка» typed into the "add
 * your own" field instead of a checked box — still counts.
 *
 * **The ✓/✗ list stays fully announced in both branches — it is never
 * hidden from assistive tech.** It is the only place a screen reader learns
 * the *complete* requirement list, covered items included; `missingText`
 * adds a plain-words sentence naming what's absent, but only ever
 * *alongside* that list, never in place of it — an earlier version of this
 * component hid the whole line once `missingText` existed, which meant a
 * screen reader could report what was missing but never confirm what was
 * already covered. Bare `✓`/`✗` glyphs read aloud as symbol names mid
 * sentence, which is not ideal, but that is a smaller cost than losing half
 * the information.
 *
 * Presentational, like `QtyStepper` and `PortionsSlider`: every string
 * arrives already translated. `missingText` is the one exception — a small
 * formatter (`(list) => tp("equipmentMissing", { list })`) rather than a
 * flat string, because the joined list of missing labels is this
 * component's own derived state (`missingEquipment`'s result), not something
 * the screen can precompute without running that same match twice. `labels`
 * mirrors `resolveEquipmentEntry`'s own `Readonly<Record<EquipmentSlug,
 * string>>` shape, so the screen keeps the one place `dishPortions` copy is
 * composed.
 */
export function EquipmentBanner({
  required,
  profileEquipment,
  labels,
  needLabel,
  missingText,
  adaptLabel,
  adaptHint,
  onAdapt,
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
  /**
   * «Не хватает: {list}» — `list` is the missing appliances' own labels,
   * comma-joined, resolved by this component (the only one that has
   * `missingEquipment`'s result) and handed to the caller's `t(...)` call so
   * translation stays in `dish-screen.tsx`. Deliberately not per-item gender
   * agreement («нужен миксер» / «нужна тёрка» / «нужны миксер и тёрка») —
   * that needs a grammatical-gender table for all eleven presets, which does
   * not exist anywhere in this codebase; «не хватает» stays invariant.
   */
  missingText: (list: string) => string;
  /** «Адаптировать (ИИ)» */
  adaptLabel: string;
  /** The caption shown beside the button while something is missing. */
  adaptHint: string;
  /**
   * Opens task 4.6's proposal sheet. Called with the button that was
   * activated, which is what `useSheetOpener` needs to hand focus back on
   * close — and the only reason this is not a bare `() => void`.
   *
   * Deliberately carries **no** list of missing appliances: `dish.adapt`
   * runs `missingEquipment` itself, against the profile the server reads, so
   * a client can neither widen nor narrow what an adaptation is asked to work
   * around.
   */
  onAdapt: (opener: HTMLElement) => void;
  profileMissingText: string;
  settingsLinkLabel: string;
}) {
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
      {/* Always announced, both branches: it is the only place the FULL
          requirement list — covered items included — reaches assistive
          tech. Hiding it in the missing branch (an earlier version of this
          component did) meant a screen reader could report what's missing
          but never confirm what's already covered. `missingText` below adds
          the words-based alternative to the bare ✓/✗ glyphs; it supplements
          this line, it does not replace it. */}
      <span>
        {needLabel} {list}
      </span>

      {covered ? null : (
        <>
          <p className={styles.missingText}>
            {missingText(missing.map((slug) => labels[slug]).join(", "))}
          </p>
          <span className={styles.hint}>{adaptHint}</span>
          {/* A real button since task 4.6 — no `aria-disabled`, and the
              banner's own «скоро» live region is gone with it: the sheet it
              opens is where every message about an adaptation now lives,
              inside that sheet's own `aria-modal` subtree. */}
          <button
            type="button"
            className={styles.adaptButton}
            onClick={(event) => onAdapt(event.currentTarget)}
          >
            {adaptLabel}
          </button>
        </>
      )}
    </div>
  );
}
