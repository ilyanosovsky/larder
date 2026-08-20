/**
 * The kitchen-equipment checklist (VISION §5, DESIGN_BRIEF §5's "kitchen
 * profile"): our own starting profile is oven, microwave, kettle, induction
 * hob, blender, grater and garlic press, with multicooker, mixer, airfryer
 * and food processor left unchecked.
 *
 * `kitchen_profiles.equipment` stores a mix of these slugs and free-form
 * user strings side by side (VISION §5: "checklist + free-form entry") —
 * the presets are only the subset the UI renders as checkboxes; anything
 * else typed into the "add your own" field lands in the same array
 * untouched.
 */
export const EQUIPMENT_PRESETS = [
  "oven",
  "microwave",
  "kettle",
  "induction_hob",
  "blender",
  "grater",
  "garlic_press",
  "multicooker",
  "mixer",
  "airfryer",
  "food_processor",
] as const;

export type EquipmentSlug = (typeof EQUIPMENT_PRESETS)[number];

const PRESET_SET: ReadonlySet<string> = new Set(EQUIPMENT_PRESETS);

/** Longest a single equipment entry may be — matches `updateKitchenProfileInput`. */
const MAX_ITEM_LENGTH = 40;

/**
 * Cleans up a raw equipment list before it is stored: trims and caps each
 * entry, drops empties, and drops duplicates.
 *
 * Deduping is exact for a preset slug (`EQUIPMENT_PRESETS` entries are
 * already canonical, so two different slugs are never "the same" appliance)
 * but case-insensitive for everything else — a free-form entry has no
 * canonical spelling, so the same word typed twice with different casing
 * (e.g. "Multicooker" and "multicooker") is one duplicate, not two chips.
 *
 * This function never sees a localized checklist label — only slugs and
 * free text. Recognizing that a typed localized label (e.g. the checklist's
 * own word for "oven") names the same appliance as the checked `oven` box
 * is `resolveEquipmentEntry()`'s job (`src/lib/equipment-entry.ts`), which
 * runs on the client *before* an "add your own" entry reaches this array:
 * it checks the box instead of appending the label as text, so whatever
 * lands here already agrees with the checklist by construction.
 *
 * Pure and framework-free so both `kitchenProfile.update` and the client
 * form that adds a chip can call it and always agree on the result.
 */
export function normalizeEquipment(list: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of list) {
    const trimmed = raw.trim().slice(0, MAX_ITEM_LENGTH).trim();
    if (trimmed.length === 0) {
      continue;
    }

    const key = PRESET_SET.has(trimmed) ? trimmed : trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}
