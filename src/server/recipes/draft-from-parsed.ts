import type { DishSourceType, RecipeDraft } from "@/lib/recipes/draft";
import { normalizeTags } from "@/lib/recipes/tags";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import { normalizeProductName, splitWords } from "@/server/catalog/normalize";
import { coerceEquipmentList } from "@/server/recipes/coerce-equipment";
import { coerceRecipeUnit, UNIT_WORDS } from "@/server/recipes/coerce-unit";
import { deriveNeedsReview } from "@/server/recipes/needs-review";
import type { ParsedRecipe } from "@/server/ai/parse-recipe";
import type { IngredientMatch } from "@/server/recipes/match-ingredients";

/**
 * `ParsedRecipe` → `RecipeDraft` — where the import's honesty is mechanized
 * (blueprint §2.3).
 *
 * Everything the model returns is free-form and unbounded; everything the
 * form and the database accept is bounded. This module is the single place
 * that boundary is crossed, and the rule at every step is the same one: **a
 * value we cannot vouch for becomes `null` plus a visible «уточнить» chip,
 * never a plausible number.**
 *
 * The three rules worth stating out loud, because each one is a tempting
 * mistake:
 *
 * 1. **Nothing is clamped.** `285.4999` does not become `285.5` and a `qty`
 *    of `0` does not become `MIN_QTY`. Clamping invents precision the source
 *    never gave, and the invented digit is invisible on the review screen —
 *    the one place a person could have caught it.
 * 2. **Nothing is dropped silently.** An unmapped measure («зубчик») moves
 *    into the row's `note`, so the recipe still says what it said.
 * 3. **No Russian string is authored here.** Every word in the result came
 *    from the source or from the model; a fallback we wrote ourselves would
 *    be UI copy living in the database, outside next-intl (AGENTS.md).
 *
 * Pure — no database, no network — so every rule is unit-tested directly.
 */

/** The upper bound `recipeDraftSchema` puts on each field, mirrored here. */
const MAX_TITLE = 120;
const MAX_RAW_TEXT = 300;
const MAX_NAME = 100;
const MAX_NOTE = 100;
const MAX_STEP_TEXT = 2000;
const MAX_INGREDIENTS = 60;
const MAX_STEPS = 60;
const MAX_EQUIPMENT = 12;
const MAX_YIELD_UNIT = 24;
const MAX_TIMER_SEC = 86_400;
const MAX_PORTIONS = 100;
const MAX_TOTAL_TIME_MIN = 6000;

/**
 * Longest a *buyable noun* may be. Well below `MAX_NAME`, on purpose: this is
 * not a storage limit but a judgement about whether the model did the noun
 * extraction it was asked for. «Шоколад» is a name; «Шоколад крупными
 * кусками, желательно 70 %» is a source line that slipped through.
 */
const MAX_EXTRACTED_NAME = 40;

/** The default yield when the source states none — `recipes.portions_base`'s own. */
const DEFAULT_PORTIONS = 2;

export type ImportWarning = "normalizationFailed" | "noSteps" | "noIngredients";

export interface DraftSource {
  readonly sourceType: DishSourceType;
  readonly sourceUrl: string | null;
  readonly photoUrl: string | null;
  readonly photoKey: string | null;
}

export type DraftFromParsedResult =
  | {
      readonly ok: true;
      readonly draft: RecipeDraft;
      readonly warnings: ImportWarning[];
    }
  /** Not a recipe at all — S8.2's honest copy, not an error screen. */
  | { readonly ok: false; readonly reason: "notARecipe" };

export interface DraftFromParsedArgs {
  readonly parsed: ParsedRecipe;
  /**
   * `matchIngredients` output, **1:1 with `parsed.ingredients`**. Only a
   * `"catalog"` hit binds here: a `"reference"` hit still has to *create* the
   * product, and products are created on save (DESIGN_BRIEF S8.3), so those
   * rows reach the form as the honest «новый» state and are resolved again by
   * `resolveIngredientProducts` when «Сохранить блюдо» is tapped.
   */
  readonly matches: readonly IngredientMatch[];
  readonly source: DraftSource;
}

export function draftFromParsed({
  parsed,
  matches,
  source,
}: DraftFromParsedArgs): DraftFromParsedResult {
  const ingredients = parsed.ingredients
    .slice(0, MAX_INGREDIENTS)
    .map((row, index) => toIngredient(row, matches[index]))
    .filter((row) => row !== null);

  const steps = parsed.steps
    .slice(0, MAX_STEPS)
    .map(toStep)
    .filter((step) => step !== null);

  // The model's own escape hatch, plus the structural version of the same
  // question: a "recipe" with neither an ingredient nor a step is a photo of
  // something else, however confidently it was described (decision D6).
  if (!parsed.isRecipe || (ingredients.length === 0 && steps.length === 0)) {
    return { ok: false, reason: "notARecipe" };
  }

  const title = pickTitle(parsed.title, ingredients, steps);
  if (title === null) {
    // Content but no nameable thing anywhere in it. Rather than authoring a
    // Russian placeholder into `dishes.title`, this becomes the same fork
    // S8.2 already draws: «создать вручную», prefilled with what we have.
    return { ok: false, reason: "notARecipe" };
  }

  const portionsBase =
    intInRange(parsed.portionsBase, 1, MAX_PORTIONS) ?? DEFAULT_PORTIONS;
  const portionsMinRaw = intInRange(parsed.portionsMin, 1, MAX_PORTIONS);

  const warnings: ImportWarning[] = [];
  if (ingredients.length === 0) {
    warnings.push("noIngredients");
  }
  if (steps.length === 0) {
    warnings.push("noSteps");
  }

  return {
    ok: true,
    warnings,
    draft: {
      title,
      photoUrl: source.photoUrl,
      photoKey: source.photoKey,
      tags: normalizeTags(parsed.tags),
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      portionsBase,
      // Equal bounds are not a range: «8–8 порций» is «8 порций», and storing
      // it would make S7 render a range for a single number.
      portionsMin:
        portionsMinRaw !== null && portionsMinRaw < portionsBase
          ? portionsMinRaw
          : null,
      yieldUnit: capped(parsed.yieldUnit, MAX_YIELD_UNIT),
      totalTimeMin: intInRange(parsed.totalTimeMin, 1, MAX_TOTAL_TIME_MIN),
      // Free Russian words → preset slugs; anything the app has no slug for
      // is dropped rather than stored, because this array exists solely to be
      // compared against `kitchen_profiles.equipment` (4.5's banner).
      equipment: coerceEquipmentList(parsed.equipment).slice(0, MAX_EQUIPMENT),
      ingredients,
      steps,
    },
  };
}

type DraftIngredient = RecipeDraft["ingredients"][number];
type DraftStep = RecipeDraft["steps"][number];

function toIngredient(
  row: ParsedRecipe["ingredients"][number],
  match: IngredientMatch | undefined,
): DraftIngredient | null {
  const rawText = capped(row.rawText, MAX_RAW_TEXT) ?? "";
  const coerced = coerceRecipeUnit(row.unit);

  const name = pickIngredientName(row.name, rawText);
  if (name === null) {
    // A row with no name and no source line is a parse artefact, not an
    // ingredient — the same judgement `isUsableProductName` makes at save.
    return null;
  }

  // The unmapped measure survives as words on the row instead of becoming a
  // wrong number: «2 зубчика» stays «2» + note «зубчик».
  const note = capped(joinNote(row.note, coerced.leftover), MAX_NOTE);

  const qty = usableQty(row.qty);

  return {
    rawText,
    name: name.value,
    qty,
    unit: coerced.unit,
    note,
    isOptional: row.isOptional,
    // `deriveNeedsReview` is the canon (a deliberately open «по вкусу» is not
    // a hole), and this ORs in the two ways *the parse itself* failed: a
    // quantity we refused to trust, and a name we had to fall back on. The
    // router recomputes the flag from `deriveNeedsReview` alone on save —
    // correctly, because by then a human has looked at the row.
    needsReview:
      deriveNeedsReview({
        qty,
        unit: coerced.unit,
        isOptional: row.isOptional,
        note,
      }) ||
      name.usedRawText ||
      (row.qty !== null && qty === null),
    // Only a row the household already owns binds here; see `matches` above.
    productId: match?.kind === "catalog" ? match.product.id : null,
  };
}

function toStep(step: ParsedRecipe["steps"][number]): DraftStep | null {
  const text = capped(step.text, MAX_STEP_TEXT);
  if (text === null) {
    return null;
  }

  const timerSec = intInRange(step.timerSec, 1, MAX_TIMER_SEC);
  const timerMaxSec = intInRange(step.timerMaxSec, 1, MAX_TIMER_SEC);

  return {
    text,
    timerSec,
    // An upper bound with no lower bound is not a range but a countdown S9
    // could not start; an upper below the lower is a misread. Either way the
    // honest answer is one number, not two wrong ones.
    timerMaxSec:
      timerSec !== null && timerMaxSec !== null && timerMaxSec >= timerSec
        ? timerMaxSec
        : null,
  };
}

/**
 * The dish's name, taken from the source and never authored here.
 *
 * The model is asked to name every recipe, including one whose photo shows no
 * heading. When it comes back empty anyway the fallbacks are still the
 * *source's* own words — the first ingredient, then the first step — because
 * a Russian placeholder written by us would be UI copy stored in
 * `dishes.title`, outside next-intl and impossible to translate later. A
 * visibly odd title is one tap to fix on the review screen; an invented one
 * looks correct and is not.
 */
function pickTitle(
  raw: string,
  ingredients: readonly DraftIngredient[],
  steps: readonly DraftStep[],
): string | null {
  return (
    capped(raw, MAX_TITLE) ??
    capped(ingredients[0]?.name ?? null, MAX_TITLE) ??
    capped(steps[0]?.text ?? null, MAX_TITLE)
  );
}

/**
 * The buyable noun, or the source line when the model clearly did not extract
 * one (blueprint R3).
 *
 * A `name` carrying a digit, a bare unit word or more than
 * `MAX_EXTRACTED_NAME` characters is a source line that slipped through, and
 * binding the catalog on it would either miss entirely or — worse — mint a
 * permanent near-duplicate product named «Шоколад крупными кусками 150 г».
 * Falling back to `rawText` keeps the row readable, keeps it unbound, and
 * flags it, which is exactly the state a human can fix in one tap.
 *
 * The cost is real and accepted: «Молоко 3,2 %» has a digit and therefore
 * falls back too. A wrongly-flagged row is a chip someone clears; a wrongly-
 * *bound* row buys the wrong thing in phase 5.2 and nobody ever sees why.
 */
function pickIngredientName(
  raw: string,
  rawText: string,
): { value: string; usedRawText: boolean } | null {
  const name = capped(raw, MAX_NAME);

  if (name !== null && isExtractedNoun(name)) {
    return { value: name, usedRawText: false };
  }

  const fallback = capped(rawText, MAX_NAME);
  if (fallback !== null) {
    return { value: fallback, usedRawText: true };
  }

  // No usable source line either: keep whatever name there was, flagged.
  return name === null ? null : { value: name, usedRawText: true };
}

function isExtractedNoun(name: string): boolean {
  if (name.length > MAX_EXTRACTED_NAME) {
    return false;
  }
  if (/[0-9]/.test(name)) {
    return false;
  }

  // Word-by-word, never as a substring: «Гречка» must not trip on «г», and
  // «Стакан йогурта» must.
  return !splitWords(normalizeProductName(name)).some((word) =>
    UNIT_WORDS.has(word),
  );
}

/**
 * A quantity we are willing to store, or `null`.
 *
 * `null` — never a clamp, never a rounding — for anything non-finite or
 * outside what `numeric(10, 3)` holds. The row then wears «уточнить» and the
 * number the source actually gave is still readable in `rawText` right above
 * the empty field.
 */
function usableQty(qty: number | null): number | null {
  if (qty === null || !Number.isFinite(qty)) {
    return null;
  }
  return qty >= MIN_QTY && qty <= MAX_QTY ? qty : null;
}

/** An integer in range, or `null`. Non-integers round; out-of-range does not. */
function intInRange(
  value: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : null;
}

/** Trimmed and capped; blank becomes `null`, because blank means absent. */
function capped(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

/** The model's note plus whatever the unit coercion could not map, once. */
function joinNote(...parts: (string | null)[]): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const part of parts) {
    const trimmed = part?.trim() ?? "";
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(trimmed);
  }

  return kept.length === 0 ? null : kept.join(", ");
}
