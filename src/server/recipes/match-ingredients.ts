import { normalizeProductName } from "@/server/catalog/normalize";
import {
  REFERENCE_PRODUCTS,
  type ReferenceProduct,
} from "@/server/catalog/reference-products";
import {
  resolveCategoryIdForSlug,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";
import {
  acceptsIngredientTier,
  bestCatalogMatch,
  findExactMatch,
  findReferenceProduct,
  type CatalogProduct,
} from "@/server/catalog/search";

/**
 * Ingredient name ⟶ catalog row, decided deterministically and for free
 * (blueprint §2.5, VISION §6.4).
 *
 * This is the step that keeps the AI bill near zero and the catalog clean: a
 * recipe's «Мука» is the household's «Мука», or the built-in reference entry
 * of that name, long before anything has to be *invented*. Only what survives
 * this module reaches the batched enrichment call in the save path.
 *
 * It works at all only because the parser returns `name` separately from
 * `rawText`: «Шоколад крупными кусками — 150 г» arrives as `name: "Шоколад"`,
 * and *that* is what a string ranker can look up. The model does the noun
 * extraction; this module does lookup, and nothing else.
 *
 * Pure — no database, no network — so every binding rule is unit-tested
 * against a small readable catalog instead of a fixture dump.
 */

export type IngredientMatch =
  /** A row the household already owns. Bind and move on: free, no write. */
  | { readonly kind: "catalog"; readonly product: CatalogProduct }
  /**
   * One of the built-in staples. Free too, but it has to be *created* first —
   * with the reference entry's own icon, department, unit and aliases, which
   * is what makes it indistinguishable from a hand-curated row afterwards.
   */
  | {
      readonly kind: "reference";
      readonly ref: ReferenceProduct;
      /** The household department `ref.categorySlug` resolves to. */
      readonly categoryId: string;
    }
  /** Nothing answers to this name — the only case that costs an AI call. */
  | { readonly kind: "none"; readonly name: string };

export interface MatchIngredientsArgs {
  /** Ingredient names, in the draft's own order. */
  readonly names: readonly string[];
  readonly products: readonly CatalogProduct[];
  readonly categories: readonly HouseholdCategory[];
  /** Overridable so tests rank against a small, readable list. */
  readonly references?: readonly ReferenceProduct[];
}

/**
 * Whether a name can become a product at all.
 *
 * A row whose name is «—», «...» or «(см. шаг 3)» is a bad parse, not an
 * ingredient. Creating a product from it would put a permanent,
 * `RESTRICT`-referenced piece of garbage in the household catalog — on the
 * app's main surface — and spend an AI call finding it an emoji. Such a row is
 * saved unbound instead, which is exactly the honest «новый» state the schema
 * already has a column for.
 *
 * Deliberately a "has a letter or a digit" test rather than a spelling
 * judgement: «Соль» and «Мука ц/з» are both fine, and a stricter rule would
 * start refusing real ingredients. No `\p{L}` — the ES2017 target cannot
 * compile Unicode property escapes (`enrich-product.ts` documents the same
 * constraint).
 */
export function isUsableProductName(name: string): boolean {
  return /[a-zа-я0-9]/.test(normalizeProductName(name));
}

/**
 * Matches every name, **1:1 with the input order** — the caller pairs results
 * back to draft rows by index, so a dropped or reordered entry would bind the
 * wrong ingredient.
 *
 * Order of attempts, cheapest and most certain first:
 *
 * 1. `findExactMatch` over the household's own catalog — its normalized name
 *    or one of its aliases, equal to the normalized query. An exact hit on a
 *    row the household already curated beats everything, ambiguity included.
 * 2. `bestCatalogMatch` through `acceptsIngredientTier` — prefix and
 *    word-prefix, on names and aliases, over catalog *and* reference entries.
 *    Substrings are refused, and so is a tie (see `bestCatalogMatch`).
 * 3. `findReferenceProduct` — the built-ins by exact name/alias. Reached only
 *    where step 2 declined to answer, which is why it is worth its own line:
 *    `searchCatalog`'s ranking drops a reference entry the household already
 *    owns under another spelling, and this is the last chance to notice the
 *    name is a staple rather than something new to invent.
 */
export function matchIngredients({
  names,
  products,
  categories,
  references = REFERENCE_PRODUCTS,
}: MatchIngredientsArgs): IngredientMatch[] {
  return names.map((name) => matchOne(name, products, categories, references));
}

function matchOne(
  name: string,
  products: readonly CatalogProduct[],
  categories: readonly HouseholdCategory[],
  references: readonly ReferenceProduct[],
): IngredientMatch {
  if (!isUsableProductName(name)) {
    return { kind: "none", name };
  }

  const owned = findExactMatch(name, products);
  if (owned) {
    return { kind: "catalog", product: owned };
  }

  const best = bestCatalogMatch({
    query: name,
    products,
    categories,
    references,
  });

  if (best && acceptsIngredientTier(best.rank)) {
    return best.hit.source === "catalog"
      ? { kind: "catalog", product: best.hit.product }
      : { kind: "reference", ref: best.hit.ref, categoryId: best.hit.categoryId };
  }

  const ref = findReferenceProduct(name, references);
  if (ref) {
    const categoryId = resolveCategoryIdForSlug(ref.categorySlug, categories);
    if (categoryId !== null) {
      return { kind: "reference", ref, categoryId };
    }
  }

  return { kind: "none", name };
}
