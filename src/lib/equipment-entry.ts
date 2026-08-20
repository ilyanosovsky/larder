import {
  EQUIPMENT_PRESETS,
  normalizeEquipment,
  type EquipmentSlug,
} from "@/server/kitchen/equipment";

export type EquipmentEntryResolution =
  { kind: "preset"; slug: EquipmentSlug } | { kind: "custom"; value: string };

/**
 * Decides what a free-form "add your own" entry actually names, before it
 * is ever added to a household's equipment list (VISION §3.3, §5).
 *
 * Someone typing the checklist's own localized label for a preset (e.g. the
 * label shown next to the `oven` checkbox) into the free-form field means
 * the same appliance as checking that box — and typing the slug itself (or
 * a different casing of either) means the same thing too. All of those must
 * check the box instead of creating a second, redundant chip beside it.
 * Anything that matches neither a slug nor a localized label is genuinely
 * free-form.
 *
 * This is deliberately a client-side concern, not `normalizeEquipment()`'s
 * (`src/server/kitchen/equipment.ts`): that function is shared with the
 * server and only ever sees slugs and free text that already agree with the
 * checklist, never a localized label — matching a label requires the
 * translated strings, which only the form has. `labels` is that mapping,
 * built from the same `kitchenProfile.equipment.*` messages the checklist
 * itself renders, so the two can never drift apart.
 */
export function resolveEquipmentEntry(
  input: string,
  labels: Readonly<Record<EquipmentSlug, string>>,
): EquipmentEntryResolution {
  const normalized = input.trim().toLowerCase();

  for (const slug of EQUIPMENT_PRESETS) {
    if (
      normalized === slug ||
      normalized === labels[slug].trim().toLowerCase()
    ) {
      return { kind: "preset", slug };
    }
  }

  return { kind: "custom", value: input.trim() };
}

/**
 * Ensures `slug` is present in `current`, exactly once.
 *
 * A free-form chip can already case-insensitively equal a slug — someone
 * typed "Oven" before the checklist existed, or before `resolveEquipmentEntry`
 * caught it — and `normalizeEquipment`'s dedup would otherwise drop the
 * *appended* canonical slug (it runs into the existing chip's key first),
 * leaving the checkbox visibly doing nothing. Dropping that stale duplicate
 * first is what makes checking the box actually check it.
 *
 * Colocated with `resolveEquipmentEntry` (rather than left inside the form
 * component) because the two are always used together — `addCustom` in
 * `kitchen-profile-form.tsx` resolves an entry, then calls this to apply
 * it — and the state transition itself (a stray case-insensitive duplicate
 * getting replaced by the canonical slug) is exactly the kind of behaviour
 * that belongs under a unit test rather than only being exercised through
 * the rendered form.
 */
export function withSlugChecked(
  current: string[],
  slug: EquipmentSlug,
): string[] {
  if (current.includes(slug)) {
    return current;
  }
  const withoutCaseInsensitiveDuplicate = current.filter(
    (item) => item.toLowerCase() !== slug.toLowerCase(),
  );
  return normalizeEquipment([...withoutCaseInsensitiveDuplicate, slug]);
}
