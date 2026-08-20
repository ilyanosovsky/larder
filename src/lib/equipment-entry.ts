import {
  EQUIPMENT_PRESETS,
  type EquipmentSlug,
} from "@/server/kitchen/equipment";

export type EquipmentEntryResolution =
  { kind: "preset"; slug: EquipmentSlug } | { kind: "custom"; value: string };

/**
 * Decides what a «Добавить своё» entry actually names, before it is ever
 * added to a household's equipment list (VISION §3.3, §5).
 *
 * Someone typing «Духовка» into the free-form field means the same
 * appliance as the checked «Духовка» checkbox — the checklist's own label
 * for the `oven` slug — and typing the slug itself (or a different casing
 * of either) means the same thing too. All of those must check the box
 * instead of creating a second, redundant chip beside it. Anything that
 * matches neither a slug nor a localized label is genuinely free-form.
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
