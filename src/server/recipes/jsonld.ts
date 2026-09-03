import { parse } from "node-html-parser";

import { parseDurationMin } from "@/server/recipes/duration";
import { EMPTY_SKELETON, type RecipeSkeleton } from "@/server/recipes/skeleton";

/**
 * schema.org `Recipe` out of a page's JSON-LD (VISION §6.4, blueprint §3.2).
 *
 * **Liberal on purpose.** JSON-LD in the wild is nothing like the spec's
 * examples: `@graph` wrappers, top-level arrays, `@type` as an array
 * (`["Recipe","NewsArticle"]`), the `"schema:Recipe"` prefix form,
 * `recipeIngredient` as one string instead of a list, `recipeInstructions` as
 * prose / a list of strings / `HowToStep` objects / `HowToSection` objects
 * with nested `itemListElement`, `image` as a string, a list, or an
 * `ImageObject`. Every one of those is on a real Russian recipe site, and a
 * strict reader would fall through to a paid FireCrawl call for a page that
 * already handed us the answer.
 *
 * The other half of "liberal" is not crashing: a page with three `ld+json`
 * blocks where one is malformed must still yield the recipe from the other
 * two, so each block is parsed inside its own `try`.
 *
 * `JSON.parse`, never `eval` — the input is a stranger's page.
 */

/** Ceiling on how much of one script block we will try to parse. */
const MAX_BLOCK_CHARS = 500_000;

/**
 * Recursion limit for `@graph` / `itemListElement` nesting — and for every
 * value reader below.
 *
 * `JSON.parse` is iterative in V8, so a 4 KB block nesting `recipeIngredient`
 * two thousand arrays deep parses happily and then blows the JS stack in
 * whichever reader walks it. That `RangeError` escapes into `fromUrl` as a
 * 500 with no `jobId`, leaving the ledger row it had already opened stuck on
 * `running`. Six levels clips nothing real: every fixture and every shape
 * this module documents sits at one or two.
 */
const MAX_DEPTH = 6;

/**
 * Longest single value this module hands on.
 *
 * A page controls every string in here, and the readers feed
 * `parseDurationMin` (whose regexes are quadratic on long digit runs) and the
 * AI hint (which is billed by the token). `MAX_BLOCK_CHARS` permits a 500 KB
 * block, so «bounded by the document» is not a bound at all. Nothing real
 * approaches this — the longest ingredient line in the four fixtures is 38
 * characters — and `draftFromParsed` caps every field again on the way into a
 * draft.
 */
const MAX_VALUE_CHARS = 2_000;

/**
 * Every `<script type="application/ld+json">` on the page, parsed.
 *
 * A block that does not parse is skipped, not fatal. `rawText` rather than
 * decoded text: script content is not entity-decoded by a browser either, and
 * `&amp;` inside a JSON string is data.
 */
export function extractJsonLdNodes(html: string): unknown[] {
  const root = parse(html, {
    // The default keeps `<script>` bodies; being explicit is what makes this
    // module's whole premise (reading script text) survive a library upgrade.
    blockTextElements: {
      script: true,
      noscript: false,
      style: false,
      pre: true,
    },
  });

  const nodes: unknown[] = [];

  for (const script of root.querySelectorAll("script")) {
    const type = script.getAttribute("type")?.trim().toLowerCase();
    if (type !== "application/ld+json") {
      continue;
    }

    const raw = stripCdata(script.rawText).trim();
    if (raw.length === 0 || raw.length > MAX_BLOCK_CHARS) {
      continue;
    }

    try {
      nodes.push(JSON.parse(raw));
    } catch {
      // One malformed block does not abort the scan — see the file comment.
    }
  }

  return nodes;
}

/** The first `Recipe` anywhere in the parsed blocks, or `null`. */
export function findRecipeNode(
  nodes: readonly unknown[],
): Record<string, unknown> | null {
  for (const node of nodes) {
    const found = searchForRecipe(node, 0);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function searchForRecipe(
  node: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchForRecipe(item, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (!isRecord(node)) {
    return null;
  }

  if (isRecipeType(node["@type"])) {
    return node;
  }

  // `@graph` is the common wrapper; `mainEntity` is how a few CMSs nest the
  // recipe under a WebPage node.
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) {
    const found = searchForRecipe(node[key], depth + 1);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function isRecipeType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];

  return types.some((type) => {
    if (typeof type !== "string") {
      return false;
    }
    // `Recipe`, `schema:Recipe`, `http://schema.org/Recipe` — all seen.
    const tail = type.split(/[/#:]/).pop()?.trim().toLowerCase();
    return tail === "recipe";
  });
}

/** A `Recipe` node → the honest subset of it this import can use. */
export function recipeSkeletonFromJsonLd(
  node: Record<string, unknown>,
): RecipeSkeleton {
  const ingredients = stringList(
    node.recipeIngredient ?? node.ingredients,
  ).filter((line) => line.length > 0);

  return {
    ...EMPTY_SKELETON,
    title: firstString(node.name ?? node.headline),
    image: firstImageUrl(node.image),
    yieldText: firstString(node.recipeYield ?? node.yield),
    totalTimeMin:
      parseDurationMin(firstString(node.totalTime)) ??
      parseDurationMin(firstString(node.cookTime)),
    ingredients,
    steps: instructionSteps(node.recipeInstructions, 0),
    tags: stringList(node.keywords ?? node.recipeCategory)
      .flatMap((value) => value.split(","))
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  };
}

/**
 * `recipeInstructions` in every shape the wild uses.
 *
 * `HowToSection` carries its own steps under `itemListElement`, so sections
 * are flattened rather than dropped — the section *heading* is deliberately
 * not emitted as a step, because «Для теста:» is not something anybody does.
 */
function instructionSteps(value: unknown, depth: number): string[] {
  if (depth > MAX_DEPTH) {
    return [];
  }

  if (typeof value === "string") {
    return splitProse(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => instructionSteps(item, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const nested = value.itemListElement ?? value.steps;
  if (nested !== undefined) {
    return instructionSteps(nested, depth + 1);
  }

  const text = firstString(value.text ?? value.name ?? value.description);
  return text === null ? [] : [text];
}

/**
 * Instructions given as one blob.
 *
 * Split on newlines only. Splitting on sentences would cut «Разогрей духовку
 * до 180 гр. C» in half, and the model is about to re-read these lines
 * anyway — one long step it can split beats five wrong ones it cannot rejoin.
 */
function splitProse(value: string): string[] {
  return value
    .split(/\r?\n+/)
    .map((line) => collapse(line))
    .filter((line) => line.length > 0);
}

function firstImageUrl(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (typeof value === "string") {
    return httpUrl(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstImageUrl(item, depth + 1);
      if (url !== null) {
        return url;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    // An `ImageObject`, or `{ "@id": "…" }`.
    return firstImageUrl(
      value.url ?? value.contentUrl ?? value["@id"],
      depth + 1,
    );
  }
  return null;
}

/** Only absolute http(s): a relative or `data:` image is not worth storing. */
function httpUrl(value: string): string | null {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** A string, a number, or the first usable member of a list. */
function firstString(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (typeof value === "string") {
    const text = collapse(value);
    return text.length === 0 ? null : text;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstString(item, depth + 1);
      if (text !== null) {
        return text;
      }
    }
  }
  if (isRecord(value)) {
    return firstString(value.name ?? value.text ?? value["@value"], depth + 1);
  }
  return null;
}

function stringList(value: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH) {
    return [];
  }
  // `depth`, not `depth + 1`, on the way into `firstString`: handing the
  // *same* value to another reader is not a level of nesting, and counting it
  // as one made the last permitted level unreachable — a line six arrays deep
  // was dropped by a limit that says it allows six.
  if (typeof value === "string" || typeof value === "number") {
    const text = firstString(value, depth);
    return text === null ? [] : [text];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringList(item, depth + 1));
  }
  if (isRecord(value)) {
    const text = firstString(value, depth);
    return text === null ? [] : [text];
  }
  return [];
}

/**
 * Whitespace collapsed **and** the result bounded — see `MAX_VALUE_CHARS`.
 * Every string this module emits passes through here, which is what makes the
 * cap one rule rather than five.
 */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCdata(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "");
}
