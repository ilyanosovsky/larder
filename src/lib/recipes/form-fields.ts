import { MAX_TAGS, normalizeTags } from "@/lib/recipes/tags";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";

/**
 * The text ⟷ number edges of the S8.3 form, pulled out of the component so
 * they can be tested at all.
 *
 * vitest runs in `node` with no DOM harness (there is no jsdom in this repo,
 * deliberately), so anything left inside a `.tsx` is unreachable from the
 * suite — the phase-4 rule the wiki records after two bugs shipped green that
 * way. Every field on the form that is a text input over a non-string value
 * goes through one of these.
 *
 * All of them are **lenient about the input and strict about the answer**: a
 * recipe is typed with a thumb, and «0,5» is what a Russian keyboard produces
 * for half a teaspoon. What must never happen is a `NaN` reaching the router,
 * where it comes back as a validation error nobody can act on.
 */

/**
 * «285» · «0,5» · «¾» → a quantity, or `null` for "unstated".
 *
 * `null` is a real value here, not a failure: an ingredient may legitimately
 * state no amount («Соль по вкусу»), and that is exactly what the amber chip
 * is derived from. Anything outside what `numeric(10, 3)` can hold is also
 * `null` — **never clamped** — because a silently corrected quantity is worse
 * than an honestly missing one.
 */
export function parseQtyInput(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned.length === 0) {
    return null;
  }

  const fraction = FRACTIONS.get(cleaned);
  if (fraction !== undefined) {
    return fraction;
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < MIN_QTY || value > MAX_QTY) {
    return null;
  }

  return value;
}

/**
 * The vulgar fractions `formatRecipeQty` renders, read back the same way.
 *
 * A `Map`, not an object literal: bracket access on a plain object also
 * resolves `Object.prototype`, so `parseQtyInput("toString")` — a word someone
 * can genuinely type into a free-text quantity field — would come back as a
 * *function*, past a `number | null` return type TypeScript still believes.
 */
const FRACTIONS = new Map<string, number>([
  ["½", 0.5],
  ["⅓", 1 / 3],
  ["⅔", 2 / 3],
  ["¼", 0.25],
  ["¾", 0.75],
]);

/**
 * A stored quantity as the input should show it: «285», «0.5», empty for
 * `null`. Plain decimals rather than `formatRecipeQty`'s «¾» — this is an
 * editable field, and a glyph the keyboard cannot produce is a trap.
 */
export function formatQtyInput(qty: number | null): string {
  if (qty === null) {
    return "";
  }
  // `toFixed(3)` then trimmed: the column is `numeric(10, 3)`, so anything
  // finer is not stored, and «0.333» beats «0.3333333333333333» in a field
  // someone is about to edit.
  return Number(qty.toFixed(3)).toString().replace(/\.0+$/, "");
}

/**
 * A whole number of minutes out of a text field, bounded — the total time and
 * both step timers. `null` for empty, for garbage and for anything outside the
 * bound, so a mistyped «600000» never reaches the schema as a validation
 * error the form cannot explain.
 */
export function parseMinutesInput(text: string, max: number): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned.length === 0) {
    return null;
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }

  const minutes = Math.round(value);
  if (minutes < 1 || minutes > max) {
    return null;
  }

  return minutes;
}

/** Seconds as the form edits them — whole minutes, empty for «no timer». */
export function minutesFromSeconds(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  return String(Math.max(1, Math.round(seconds / 60)));
}

/** Minutes back to the seconds the column stores. */
export function secondsFromMinutes(minutes: number | null): number | null {
  return minutes === null ? null : minutes * 60;
}

/** What tapping «Добавить» on the tag field actually did. */
export type TagAddOutcome = "added" | "blank" | "duplicate" | "full";

/**
 * Whether a typed tag joins the list, and if not, why.
 *
 * `normalizeTags` truncates at `MAX_TAGS` and drops blanks and duplicates —
 * `recipeDraftSchema.tags.max(MAX_TAGS)` depends on that — so from the outside
 * all three refusals look identical: the array comes back the same length.
 * Only `"full"` is worth telling the user about, and only `"full"` must keep
 * the typed word in the field; a duplicate is already visible as a chip right
 * above the input, and a blank is not an attempt at anything.
 *
 * A function rather than a condition inline in the form, because there is no
 * DOM test harness in this repo: a branch left in a `.tsx` is unreachable from
 * vitest, and the first version of this one reported a full list for an empty
 * field.
 */
export function tagAddOutcome(
  tags: readonly string[],
  raw: string,
): TagAddOutcome {
  const normalized = normalizeTags([raw])[0];
  if (normalized === undefined) {
    return "blank";
  }
  if (tags.includes(normalized)) {
    return "duplicate";
  }
  return tags.length >= MAX_TAGS ? "full" : "added";
}
