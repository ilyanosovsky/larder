import type { EquipmentSlug } from "@/server/kitchen/equipment";

import { coerceEquipmentList } from "./coerce-equipment";

/**
 * What S7's equipment banner (task 4.5) and 4.6's adaptation both need to
 * know: which of a recipe's required appliances the household's kitchen
 * profile does not cover.
 *
 * `profile` is run through `coerceEquipmentList` before comparing, so a
 * free-form "add your own" entry that happens to name a preset appliance
 * («мультиварка», typed before the checklist existed, or after
 * `resolveEquipmentEntry` missed it) still satisfies that requirement — the
 * household is not asked to re-declare an appliance it already wrote down in
 * its own words. `required` arrives as `EquipmentSlug[]` already (`recipes
 * .equipment` holds preset slugs only, coerced on the way in), so it needs no
 * second pass here.
 *
 * `null` profile — a household that has never opened the kitchen-profile
 * onboarding step or Settings — is not this function's concern: the caller
 * (the S7 banner) renders «Профиль кухни не заполнен» for that case instead
 * of asking what is missing from a profile that does not exist, and passes
 * `[]` only if it chooses to answer that question anyway.
 */
export function missingEquipment(
  required: readonly EquipmentSlug[],
  profile: readonly string[],
): EquipmentSlug[] {
  const have = new Set(coerceEquipmentList(profile));

  return required.filter((slug) => !have.has(slug));
}
