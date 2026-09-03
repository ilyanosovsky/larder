import { parse, type HTMLElement } from "node-html-parser";

import { parseDurationMin } from "@/server/recipes/duration";
import { EMPTY_SKELETON, type RecipeSkeleton } from "@/server/recipes/skeleton";

/**
 * schema.org `Recipe` expressed as microdata — the second rung of the cascade
 * (VISION §6.4: povar.ru publishes exactly this and no JSON-LD).
 *
 * Microdata is HTML attributes rather than a document, which makes one rule
 * load-bearing: **an `itemprop` belongs to the nearest enclosing `itemscope`,
 * not to the page.** povar.ru's recipe contains a nested `Person` (the
 * author) with its own `name`, a `NutritionInformation`, an
 * `AggregateRating`, and thirteen `HowToStep`s each with their own `image`.
 * Reading `[itemprop="name"]` off the whole subtree would title the dish
 * after its author; reading `[itemprop="image"]` would return step 1's photo.
 * `ownedBy` is what keeps that from happening.
 *
 * Values come from the place the spec puts them, which is not always the
 * text: `<meta itemprop="totalTime" content="PT30M">` and `<img
 * itemprop="image" src="…">` both carry theirs in an attribute.
 */

/** Root itemtypes we accept, in either scheme and with or without www. */
const RECIPE_ITEMTYPE = /schema\.org\/recipe$/i;

/** The nested item type whose members are steps. */
const HOW_TO_STEP = /schema\.org\/howtostep$/i;

export function recipeSkeletonFromMicrodata(
  html: string,
): RecipeSkeleton | null {
  const root = parse(html);
  const recipe = findRecipeScope(root);
  if (recipe === null) {
    return null;
  }

  const ingredients = propValues(recipe, "recipeIngredient").filter(
    (line) => line.length > 0,
  );

  return {
    ...EMPTY_SKELETON,
    title: propValues(recipe, "name")[0] ?? null,
    image: propValues(recipe, "image").find(isHttpUrl) ?? null,
    yieldText: propValues(recipe, "recipeYield")[0] ?? null,
    totalTimeMin:
      parseDurationMin(propValues(recipe, "totalTime")[0] ?? null) ??
      parseDurationMin(propValues(recipe, "cookTime")[0] ?? null),
    ingredients,
    steps: instructionSteps(recipe),
    tags: propValues(recipe, "keywords")
      .concat(propValues(recipe, "recipeCategory"))
      .flatMap((value) => value.split(/[,/]/))
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  };
}

function findRecipeScope(root: HTMLElement): HTMLElement | null {
  for (const element of root.querySelectorAll("[itemtype]")) {
    const itemtype = element.getAttribute("itemtype")?.trim() ?? "";
    if (RECIPE_ITEMTYPE.test(itemtype.replace(/\/+$/, ""))) {
      return element;
    }
  }
  return null;
}

/**
 * Every value of `itemprop` that belongs to `scope` itself.
 *
 * Order is document order, which is the order the ingredients were written —
 * the one thing a recipe list cannot afford to lose.
 */
function propValues(scope: HTMLElement, name: string): string[] {
  const values: string[] = [];

  for (const element of scope.querySelectorAll(`[itemprop]`)) {
    if (!hasProp(element, name) || !ownedBy(element, scope)) {
      continue;
    }
    const value = propValue(element);
    if (value !== null) {
      values.push(value);
    }
  }

  return values;
}

/** `itemprop` may list several names, space-separated, per the spec. */
function hasProp(element: HTMLElement, name: string): boolean {
  const raw = element.getAttribute("itemprop")?.trim().toLowerCase() ?? "";
  return raw.split(/\s+/).includes(name.toLowerCase());
}

/**
 * Is `scope` the nearest enclosing `itemscope` of `element`?
 *
 * Walks from the element's parent, so a `HowToStep` — itself an `itemscope`
 * whose parent chain reaches the recipe with nothing scoped in between — is
 * owned by the recipe, while the `text` *inside* that step is not.
 */
function ownedBy(element: HTMLElement, scope: HTMLElement): boolean {
  let node = element.parentNode as HTMLElement | null;

  while (node !== null && node !== scope) {
    if (node.hasAttribute?.("itemscope")) {
      return false;
    }
    node = node.parentNode as HTMLElement | null;
  }

  return node === scope;
}

/**
 * The spec's value for one property.
 *
 * `<meta>` and `<time>` carry theirs in an attribute, `<img>`/`<a>` carry a
 * URL, and everything else is its text. Reading only `textContent` would lose
 * every duration on the page — povar.ru states `totalTime` in a `<meta>`.
 */
function propValue(element: HTMLElement): string | null {
  const tag = element.tagName?.toLowerCase() ?? "";

  const attribute =
    tag === "meta"
      ? element.getAttribute("content")
      : tag === "img" || tag === "audio" || tag === "video"
        ? element.getAttribute("src")
        : tag === "a" || tag === "link" || tag === "area"
          ? element.getAttribute("href")
          : tag === "time"
            ? (element.getAttribute("datetime") ?? element.text)
            : null;

  const value = collapse(attribute ?? element.text);
  return value.length === 0 ? null : value;
}

/**
 * `recipeInstructions`, as either a list of `HowToStep`s or one text block.
 *
 * A `HowToStep` in the wild often has no `text` property at all (povar.ru
 * writes the sentence into a plain `<div>` beside the step photo), so the
 * step's own text is the fallback — and its nested `image` contributes
 * nothing, because an `<img>` holds no text.
 */
function instructionSteps(recipe: HTMLElement): string[] {
  const containers = recipe
    .querySelectorAll("[itemprop]")
    .filter(
      (element) =>
        hasProp(element, "recipeInstructions") && ownedBy(element, recipe),
    );

  const steps: string[] = [];

  for (const container of containers) {
    const howToSteps = container
      .querySelectorAll("[itemtype]")
      .filter((element) =>
        HOW_TO_STEP.test(
          (element.getAttribute("itemtype") ?? "").trim().replace(/\/+$/, ""),
        ),
      );

    if (howToSteps.length > 0) {
      for (const step of howToSteps) {
        const named =
          propValues(step, "text")[0] ?? propValues(step, "name")[0] ?? null;
        const text = named ?? collapse(step.text);
        if (text.length > 0) {
          steps.push(text);
        }
      }
      continue;
    }

    // One block of prose: split on newlines only, for the same reason
    // `jsonld.ts` does — sentence splitting cuts «до 180 гр. C» in half.
    for (const line of container.text.split(/\r?\n+/)) {
      const text = collapse(line);
      if (text.length > 0) {
        steps.push(text);
      }
    }
  }

  return steps;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
