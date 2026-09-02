/**
 * The amber «уточнить» chip (DESIGN_BRIEF §3 NeedsReviewChip), decided
 * server-side and nowhere else.
 *
 * The rule in one sentence: **a row wears the chip only when the parser
 * failed, never when the recipe deliberately left the amount open.** «Соль по
 * вкусу» is a complete instruction; «Кукурузный крахмал» with no number is a
 * hole in the import. Flagging both would make the chip mean "there is a
 * number missing somewhere", which is not something anyone can act on — and a
 * chip nobody acts on stops being read at all.
 *
 * It is derived, never carried: the AI's structured output has no
 * `needsReview` field (task 4.3), and `dish.create`/`dish.update` recompute
 * it on every save. So a model that forgets to flag cannot produce a silently
 * confident recipe, and typing a quantity into S8.3 clears the chip without
 * anything else having to remember to.
 *
 * Pure — no database, no React — so the form can render the chip live from
 * the same function the server stores its answer from.
 */

/**
 * Phrases that mean "there is no number, and that is the recipe's intent".
 *
 * Matched as substrings of the normalized note rather than by equality: the
 * note a parser produces is «по вкусу», but a person typing the same row may
 * write «соль по вкусу» or «по вкусу, немного». Compared lower-case with
 * ё→е folded, the same two steps `normalizeProductName` starts with, because
 * «на глаз» and «На Глаз» are the same instruction.
 */
const UNQUANTIFIABLE_PHRASES = [
  "по вкусу",
  "на глаз",
  "сколько возьмет",
  "по желанию",
] as const;

export function isUnquantifiable(note: string | null): boolean {
  if (note === null) {
    return false;
  }

  const normalized = note.trim().toLowerCase().replaceAll("ё", "е");

  return UNQUANTIFIABLE_PHRASES.some((phrase) => normalized.includes(phrase));
}

/** An ingredient row, as the rule sees it. A draft row satisfies this. */
export interface NeedsReviewInput {
  qty: number | null;
  /**
   * Present because callers hand whole rows and the field belongs to the
   * shape — but deliberately **not** read. A quantity with no unit the app
   * recognizes is still a quantity («2 зубчика» parses to `qty: 2`,
   * `unit: null`, `note: "зубчик"`), and flagging it would put the amber chip
   * on a row that states its amount perfectly well.
   */
  unit: string | null;
  isOptional: boolean;
  note: string | null;
}

/**
 * | state                                     | needsReview |
 * | ----------------------------------------- | ----------- |
 * | `qty !== null`                            | `false`     |
 * | `qty === null && isOptional`              | `false` — «Biscoff — опционально» |
 * | `qty === null && isUnquantifiable(note)`  | `false` — «Соль по вкусу» |
 * | `qty === null` otherwise                  | `true` — «Кукурузный крахмал — уточнить» |
 */
export function deriveNeedsReview(row: NeedsReviewInput): boolean {
  if (row.qty !== null) {
    return false;
  }

  if (row.isOptional) {
    return false;
  }

  return !isUnquantifiable(row.note);
}
