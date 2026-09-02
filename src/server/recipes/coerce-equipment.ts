import { EQUIPMENT_PRESETS, type EquipmentSlug } from "@/server/kitchen/equipment";

/**
 * Maps one Russian equipment word or slug, matched **in full** after
 * ё/case/whitespace normalization ("духовка", "Тёрка", "индукционная плита",
 * "oven"), to the preset slug it names — so `recipes.equipment` (task 4.3's
 * parser output: a list of such words, already split out of the recipe text)
 * and `kitchen_profiles.equipment` (a mix of slugs and free text, VISION §5)
 * can be compared against each other by 4.5's banner and 4.6's adaptation
 * without silently never matching.
 *
 * **Whole-string, not phrase-scanning.** "нужна духовка" and "миксером" both
 * return `null` — a sentence needs a word-boundary/stem-matching scan this
 * module does not do, because no caller today hands it one (recipe equipment
 * arrives as a word list, never running prose; see `coerceEquipmentSlug`'s
 * own doc comment). A future caller that does need to scan step text for
 * mentioned equipment gets its own function and its own tests, not a second
 * job folded into this one.
 *
 * Deliberately **not** `resolveEquipmentEntry()`'s job
 * (`src/lib/equipment-entry.ts`): that function matches a *localized checklist
 * label* and needs the translated strings the client renders, which the
 * server does not have. This module only ever sees the words a recipe itself
 * used (or a slug already), never a `kitchenProfile.equipment.<slug>` label.
 */

/**
 * Folds ё→е, lowercases and collapses whitespace runs to one space — the same
 * three steps `normalizeProductName` starts with, so «тёрка», «Тёрка» and
 * «терка» are one lookup key.
 */
function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

const PRESET_SET: ReadonlySet<string> = new Set(EQUIPMENT_PRESETS);

/**
 * Russian words a recipe actually uses, to the slug they name. Multiple
 * spellings map to the same preset on purpose — «плита» alone is ambiguous
 * between a gas and an induction hob, but this app only ever asks about the
 * one kind, so the bare word is treated as naming it.
 */
const WORD_TO_SLUG: Readonly<Record<string, EquipmentSlug>> = {
  духовка: "oven",
  микроволновка: "microwave",
  свч: "microwave",
  чайник: "kettle",
  "индукционная плита": "induction_hob",
  плита: "induction_hob",
  блендер: "blender",
  терка: "grater",
  чеснокодавилка: "garlic_press",
  "пресс для чеснока": "garlic_press",
  мультиварка: "multicooker",
  миксер: "mixer",
  аэрогриль: "airfryer",
  "кухонный комбайн": "food_processor",
  комбайн: "food_processor",
};

/**
 * A single raw word or slug → the preset it names, or `null` when nothing
 * matches. A slug maps to itself (ё/case/whitespace-insensitive), so calling
 * this on an already-coerced value is a safe no-op — `missingEquipment` relies
 * on that to treat `required` and `profile` the same way.
 */
export function coerceEquipmentSlug(raw: string): EquipmentSlug | null {
  const normalized = normalize(raw);

  if (normalized.length === 0) {
    return null;
  }

  if (PRESET_SET.has(normalized)) {
    return normalized as EquipmentSlug;
  }

  return WORD_TO_SLUG[normalized] ?? null;
}

/**
 * The whole list, with anything unrecognized dropped and the result deduped —
 * order stable, keyed by each entry's *first* occurrence, not the input's own
 * alphabetical or preset order.
 */
export function coerceEquipmentList(raw: readonly string[]): EquipmentSlug[] {
  const seen = new Set<EquipmentSlug>();
  const result: EquipmentSlug[] = [];

  for (const entry of raw) {
    const slug = coerceEquipmentSlug(entry);
    if (slug === null || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    result.push(slug);
  }

  return result;
}
