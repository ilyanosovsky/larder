import type { ParsedRecipe } from "@/server/ai/parse-recipe";
import { parsePortions } from "@/lib/recipes/portions";

/**
 * What a free extraction (JSON-LD or microdata) can honestly claim to know
 * about a page (blueprint §3.2).
 *
 * Deliberately *not* a `ParsedRecipe`. A skeleton holds source **lines** —
 * «Смешанный фарш, 400 г» — not the noun, quantity and unit a draft needs;
 * pulling those three out of a Russian line is the job of the normalizer, and
 * pretending a regex could do it is how «муки» ends up in the product
 * catalog (decision D15).
 *
 * Every field is nullable or empty-able, because every one of them is absent
 * on some real page.
 */
export interface RecipeSkeleton {
  readonly title: string | null;
  /** A remote image URL. Never uploaded — see `draftFromParsed`'s source. */
  readonly image: string | null;
  /** The source's own yield text: «8», «7–8 порций», «5». */
  readonly yieldText: string | null;
  readonly totalTimeMin: number | null;
  /** One string per ingredient line, verbatim. */
  readonly ingredients: readonly string[];
  /** One string per step, verbatim and in order. */
  readonly steps: readonly string[];
  readonly tags: readonly string[];
}

/**
 * Longest hint we hand the model. A page with more ingredient text than this
 * is a listing page, not a recipe, and a longer prompt only costs money.
 */
const MAX_HINT_CHARS = 12_000;

/** How many lines are worth sending. Beyond this it is not a recipe card. */
const MAX_HINT_LINES = 120;

export const EMPTY_SKELETON: RecipeSkeleton = {
  title: null,
  image: null,
  yieldText: null,
  totalTimeMin: null,
  ingredients: [],
  steps: [],
  tags: [],
};

/**
 * Is this extraction worth spending an AI call on?
 *
 * **One ingredient, zero steps allowed.** A bake-list card with no method is
 * still a recipe a household wants in its library — DESIGN_BRIEF's own NYC
 * Cookies card is mostly a shopping list — and the review screen exists
 * precisely so the missing half can be typed in. Zero *ingredients*, on the
 * other hand, means the page's structured data described something else.
 */
export function isUsableSkeleton(skeleton: RecipeSkeleton): boolean {
  return skeleton.ingredients.length > 0;
}

/**
 * The skeleton, rendered as the hint the shared prompt's `skeleton` mode
 * corrects (decision D15).
 *
 * Plain labelled lines rather than JSON: the model is being asked to *read*
 * this, not to echo its shape back, and a JSON blob invites it to copy fields
 * across verbatim — including the genitive «муки» this call exists to fix.
 * No instructions here; they live in the prompt, and duplicating them in the
 * data would be two places to fix one parsing bug.
 */
export function skeletonToHint(skeleton: RecipeSkeleton): string {
  const lines: string[] = [];

  if (skeleton.title !== null) {
    lines.push(`Название: ${skeleton.title}`);
  }
  if (skeleton.yieldText !== null) {
    lines.push(`Выход: ${skeleton.yieldText}`);
  }
  if (skeleton.totalTimeMin !== null) {
    lines.push(`Время: ${skeleton.totalTimeMin} мин`);
  }
  if (skeleton.tags.length > 0) {
    lines.push(`Теги: ${skeleton.tags.join(", ")}`);
  }

  if (skeleton.ingredients.length > 0) {
    lines.push("", "Ингредиенты:");
    for (const line of skeleton.ingredients.slice(0, MAX_HINT_LINES)) {
      lines.push(`- ${line}`);
    }
  }

  if (skeleton.steps.length > 0) {
    lines.push("", "Шаги:");
    skeleton.steps.slice(0, MAX_HINT_LINES).forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }

  return lines.join("\n").slice(0, MAX_HINT_CHARS);
}

/**
 * The skeleton as a `ParsedRecipe`, for when the normalizer could not run.
 *
 * **The import still succeeds** (blueprint §3.2): every ingredient line
 * becomes its own `rawText`, the name falls back to that same line, and the
 * quantity stays `null` — which `draftFromParsed` turns into the amber
 * «уточнить» chip. The result is a fully editable draft of the recipe the
 * page actually contained, plus a `normalizationFailed` warning, instead of
 * an error screen for a page we had already read successfully.
 *
 * Nothing is invented here: no unit is guessed out of a line, and no Russian
 * string is authored. `isRecipe` is `true` because a page with ingredient
 * lines *is* a recipe — the model's escape hatch is about photos of cats, and
 * it never ran.
 */
export function skeletonToParsedRecipe(skeleton: RecipeSkeleton): ParsedRecipe {
  const portions =
    skeleton.yieldText === null ? null : parsePortions(skeleton.yieldText);

  return {
    isRecipe: true,
    title: skeleton.title ?? "",
    portionsBase: portions?.base ?? null,
    portionsMin: portions?.min ?? null,
    yieldUnit: null,
    totalTimeMin: skeleton.totalTimeMin,
    equipment: [],
    tags: [...skeleton.tags],
    ingredients: skeleton.ingredients.map((line) => ({
      rawText: line,
      // The line itself, not a noun cut out of it with a regex: an unbound
      // row a person can read is honest, a wrongly-cut one is not.
      name: line,
      qty: null,
      unit: null,
      note: null,
      isOptional: false,
    })),
    steps: skeleton.steps.map((text) => ({
      text,
      timerSec: null,
      timerMaxSec: null,
    })),
  };
}
