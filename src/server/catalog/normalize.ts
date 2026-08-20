/**
 * The one normalization the whole catalog agrees on.
 *
 * Every place that compares two product names — autocomplete ranking, the
 * reference-catalog merge, the duplicate check in `product.create`, the
 * reference-catalog invariants test — runs strings through this and nothing
 * else. Two spellings that normalize to the same string are the same product
 * as far as Larder is concerned.
 *
 * **The database agrees, exactly.** Its output is stored on every row as
 * `products.normalizedName`, and the unique index is on that column — so
 * "the same product" means one thing in the matcher and in the constraint,
 * rather than the constraint enforcing some weaker subset.
 *
 * Changing any step below therefore changes an invariant already written into
 * rows: existing `normalizedName` values need a backfill migration, and the
 * backfill in `0005_breezy_shaman` is a snapshot of this rule, not a live
 * copy of it.
 *
 * The steps, and why each one is here:
 *
 * - **lower case** — "Молоко" and "молоко" are one product.
 * - **ё → е** — Russian keyboards and habits differ, and half the country
 *   types "гречка"/"тёрка" without the diaeresis. Someone searching "гречнев"
 *   must find "Гречнёвая крупа".
 * - **collapsed whitespace** — a stray double space between words is a typo,
 *   not a different product.
 *
 * Deliberately *not* here: stripping punctuation or hyphens (they carry
 * meaning: "мясо-гриль"), and any stemming — Russian morphology needs a real
 * stemmer, and aliases cover the cases that matter for a shopping list.
 */
export function normalizeProductName(value: string): string {
  return value.trim().toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ");
}

/**
 * Splits a normalized string into its words, for word-boundary matching:
 * typing "олив" should find "Масло оливковое", not only names that *start*
 * with it. Hyphens count as boundaries too ("мясо-гриль" → мясо, гриль).
 */
export function splitWords(normalized: string): string[] {
  return normalized.split(/[\s-]+/).filter((word) => word.length > 0);
}
