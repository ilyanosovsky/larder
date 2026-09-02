import { normalizeProductName } from "@/server/catalog/normalize";
import {
  REFERENCE_PRODUCTS,
  type ReferenceProduct,
} from "@/server/catalog/reference-products";
import type { HouseholdCategory } from "@/server/catalog/resolve-category";
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
 * A row whose name is «—», «...», «-» or «•» is punctuation a parse left
 * behind, not an ingredient. Creating a product from it would put a permanent,
 * `RESTRICT`-referenced piece of garbage in the household catalog — on the
 * app's main surface — and spend an AI call finding it an emoji. Such a row is
 * saved unbound instead, which is exactly the honest «новый» state the schema
 * already has a column for.
 *
 * **The rule is "has a letter or a digit", and nothing more.** It is not a
 * judgement about whether the name reads like a product: «(см. шаг 3)» has
 * letters and digits and therefore passes, and so it should — a stricter rule
 * would start refusing «Мука ц/з», «Молоко 3.2%» and «Соль (крупная)», and a
 * wrongly-refused ingredient is a silently unbound row nobody can explain. No
 * `\p{L}` either: the ES2017 target cannot compile Unicode property escapes
 * (`enrich-product.ts` documents the same constraint).
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
 * 1b. The same question asked through the reference list: if the name *is* a
 *    built-in staple and the household owns that staple under another
 *    spelling, bind their row. See `ownedUnderAnotherSpelling`.
 * 2. `bestCatalogMatch` through `acceptsIngredientTier` — prefix and
 *    word-prefix, on names and aliases, over catalog *and* reference entries.
 *    Substrings are refused, and so is a tie (see `bestCatalogMatch`).
 * **There is deliberately no fourth attempt.** An earlier draft fell back to
 * `findReferenceProduct` once ranking declined, on the grounds that the ranker
 * drops a built-in the household already owns — but step 1b answers that case
 * now, and better. What would be left is the case where `bestCatalogMatch`
 * refused a *tie*, and resolving it by taking whichever staple the reference
 * array happens to list first is exactly the arbitrary bind the tie rule
 * exists to prevent. An ambiguous name stays unbound and a human chooses.
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

  // The built-in entry this name *is*, if any — looked up once and used twice.
  const ref = findReferenceProduct(name, references);

  // Before any ranking: the household may already own this exact staple under
  // a spelling the query never mentions — «Томаты» for a recipe's «Помидоры»,
  // «Картошка» for «Картофель». `rankCatalog` drops such a reference entry (it
  // would be a duplicate of a row the household has), and without this the
  // name falls through to whatever *else* ranks — «Помидоры черри» at the
  // prefix tier — or, at step 3, to minting a second row for one product whose
  // aliases name the first. The unique index covers `normalized_name` only, so
  // nothing downstream would stop it. An exact staple the household owns beats
  // a prefix match on a different product, which is the rule the ranker itself
  // already encodes for everything it can see.
  const ownedStaple =
    ref === null ? null : ownedUnderAnotherSpelling(ref, products);
  if (ownedStaple) {
    return { kind: "catalog", product: ownedStaple };
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
      : {
          kind: "reference",
          ref: best.hit.ref,
          categoryId: best.hit.categoryId,
        };
  }

  return { kind: "none", name };
}

/**
 * The household's own row for a reference entry, found through the entry's
 * name or any of its aliases — the same collision test `searchCatalog` runs
 * before it offers a built-in staple beside a row the household already has.
 */
function ownedUnderAnotherSpelling(
  ref: ReferenceProduct,
  products: readonly CatalogProduct[],
): CatalogProduct | null {
  const byName = findExactMatch(ref.name, products);
  if (byName) {
    return byName;
  }

  for (const alias of ref.aliases) {
    const byAlias = findExactMatch(alias, products);
    if (byAlias) {
      return byAlias;
    }
  }

  return null;
}
