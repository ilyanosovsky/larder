/**
 * Dish tags: «ужин», «духовка», «быстро» (DESIGN_BRIEF §5).
 *
 * Tags are user content, not a vocabulary — the library's filter chips are
 * built from whatever the household actually typed or an import proposed
 * (`collectTags`, `src/lib/recipes/filter-dishes.ts`). What this module owns
 * is the one canonical form they are stored in, so «Ужин», «ужин » and
 * «ужин» are one chip rather than three.
 *
 * Pure and shared: the same function runs in the S8.3 tag input (task 4.2)
 * and in `dish.create`/`dish.update` on the server, so the chip a person sees
 * while typing is exactly the chip that gets stored.
 */

/** Longest a single tag may be — the S6 chip row is not a place for a sentence. */
export const MAX_TAG_LENGTH = 24;

/**
 * How many tags one dish may carry. A cap rather than a validation error the
 * user has to resolve: past a dozen, tags stop being a filter and become a
 * second description.
 */
export const MAX_TAGS = 12;

/**
 * Trims, lower-cases, collapses inner whitespace, drops empties and
 * duplicates, and caps both the length of each tag and how many survive.
 *
 * Lower-case rather than `normalizeProductName`'s full canon (which also
 * folds ё→е): a tag is displayed exactly as it is stored, and «ежик» in place
 * of «ёжик» would be a visible rewrite of the user's own word. Matching a
 * search query against tags *is* ё-insensitive — that comparison happens in
 * `filterDishes`, where nothing is being stored.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw) {
    const tag = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, MAX_TAG_LENGTH)
      .trim();

    if (tag.length === 0 || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    result.push(tag);

    if (result.length === MAX_TAGS) {
      break;
    }
  }

  return result;
}
