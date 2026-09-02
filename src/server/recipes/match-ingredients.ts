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
 * 2. The same question asked through the reference list: if the name *is* a
 *    built-in staple and the household owns that staple under another
 *    spelling, bind their row. See `ownedUnderAnotherSpelling`.
 * 3. `bestCatalogMatch` through `acceptsIngredientTier` — prefix and
 *    word-prefix, on names and aliases, over catalog *and* reference entries.
 *    Substrings are refused, and so is a tie (see `bestCatalogMatch`).
 *
 * 4. `findReferenceProduct` — is this word simply the *name* of a staple we
 *    ship? A different question from step 3's «which is closest?», and one
 *    the ranker cannot answer: «сыр» is a prefix of both «Сыр твёрдый» and
 *    «Сыр плавленый», so ranking declines the tie — while «сыр» is the alias
 *    of «Сыр твёрдый» outright. This step cannot make an arbitrary choice,
 *    because no normalized spelling appears on two entries (pinned in
 *    `reference-products.test.ts`).
 *
 * **A tie is still refused where nothing names it exactly.** «масло» is a
 * prefix of three different fats and the name of none of them, so it reaches
 * step 4, finds nothing, and stays unbound for a human to resolve.
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

  // Before any ranking: the household may already own this exact staple under
  // a spelling the query never mentions — «Томаты» for a recipe's «Помидоры»,
  // «Картошка» for «Картофель». `rankCatalog` drops such a built-in (it would
  // be a duplicate of a row the household has), so without this the name falls
  // through to whatever *else* ranks — «Помидоры черри» at the prefix tier —
  // and a save would then mint a second row for one product, each naming the
  // other in its aliases. The unique index covers `normalized_name` only, so
  // nothing downstream would stop it. An exact staple the household owns beats
  // a prefix match on a different product, which is the rule the ranker itself
  // already encodes for everything it can see.
  const entry = findReferenceProduct(name, references);
  const ownedStaple =
    entry === null ? null : ownedUnderAnotherSpelling(entry, products);
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

  // The ranker answers «which of these is closest?» and refuses to guess when
  // two are equally close. This asks a different question — «is this word the
  // name of a staple we ship?» — and it is unique by construction, so it can
  // never resolve a tie by array order (`reference-products.test.ts` pins that
  // no spelling appears on two entries).
  //
  // It is what a whole family of everyday words depends on. «сыр» ranks as a
  // prefix of «Сыр твёрдый» *and* «Сыр плавленый», so the ranker declines —
  // but «сыр» is itself the alias of «Сыр твёрдый», which is exactly what a
  // recipe means by it. Same for «сахар», «чай», «капуста», «колбаса»,
  // «помидор», «томат». Without this each of them costs a billed enrichment
  // call and mints a bare row named with the user's own wording, which then
  // permanently hides the curated staple from autocomplete.
  if (entry) {
    const categoryId = resolveCategoryIdForSlug(entry.categorySlug, categories);
    if (categoryId !== null) {
      return { kind: "reference", ref: entry, categoryId };
    }
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
