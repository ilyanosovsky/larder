import type { Unit } from "@/lib/units";
import { normalizeProductName, splitWords } from "@/server/catalog/normalize";
import {
  REFERENCE_PRODUCTS,
  type ReferenceProduct,
} from "@/server/catalog/reference-products";
import {
  resolveCategoryIdForSlug,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";

/** A row of the household's own catalog, as the matcher needs it. */
export interface CatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly categoryId: string;
  readonly defaultUnit: Unit;
  readonly aliases: readonly string[];
}

export type CatalogSearchHit =
  | { readonly source: "catalog"; readonly product: CatalogProduct }
  | {
      readonly source: "reference";
      readonly ref: ReferenceProduct;
      /** The household department this reference entry maps onto. */
      readonly categoryId: string;
    };

export interface SearchCatalogArgs {
  readonly query: string;
  readonly products: readonly CatalogProduct[];
  readonly categories: readonly HouseholdCategory[];
  /** Overridable so tests can rank against a small, readable list. */
  readonly references?: readonly ReferenceProduct[];
}

/** How many suggestions the sheet shows before the list stops being useful. */
export const SEARCH_RESULT_LIMIT = 10;

/**
 * Match quality, best first. The name tiers come before every alias tier: a
 * product literally called what you typed beats one that merely lists it as a
 * synonym, however good the synonym's own match is.
 */
const TIER_NAME_EXACT = 0;
const TIER_NAME_PREFIX = 1;
const TIER_NAME_WORD_PREFIX = 2;
const TIER_NAME_SUBSTRING = 3;
/** Alias tiers are the name tiers shifted down by one block. */
const ALIAS_TIER_OFFSET = 4;
const NO_MATCH = Number.POSITIVE_INFINITY;

/**
 * Ranks one normalized candidate against one normalized query.
 *
 * String comparisons only — `indexOf`/`startsWith`, never a regex built from
 * the query. Anything else would either need escaping or hand a user typing
 * «сыр (твёрдый)» a SyntaxError (or, worse, a catastrophic backtrack).
 */
function matchTier(candidate: string, query: string): number {
  if (candidate === query) {
    return TIER_NAME_EXACT;
  }
  if (candidate.startsWith(query)) {
    return TIER_NAME_PREFIX;
  }

  const index = candidate.indexOf(query);
  if (index === -1) {
    return NO_MATCH;
  }

  const startsAWord = splitWords(candidate).some((word) =>
    word.startsWith(query),
  );
  return startsAWord ? TIER_NAME_WORD_PREFIX : TIER_NAME_SUBSTRING;
}

/** The best tier this entry reaches, over its name and all its aliases. */
function rankEntry(
  name: string,
  aliases: readonly string[],
  query: string,
): number {
  let best = matchTier(normalizeProductName(name), query);

  for (const alias of aliases) {
    const tier = matchTier(normalizeProductName(alias), query);
    if (tier !== NO_MATCH) {
      best = Math.min(best, tier + ALIAS_TIER_OFFSET);
    }
  }

  return best;
}

interface RankedHit {
  readonly hit: CatalogSearchHit;
  readonly rank: number;
  readonly name: string;
  /** Catalog before reference on a tie — see the sort comment below. */
  readonly sourceOrder: number;
}

/**
 * Autocomplete over the household's catalog, topped up with the built-in
 * reference catalog (VISION §3.1, DESIGN_BRIEF S4).
 *
 * Both halves are ranked by the same rules and rendered identically — that
 * sameness is the feature. A shopper typing «пом» should not have to know or
 * care whether «Помидоры» is already a row in their household's catalog or
 * one of the 189 staples shipped with the app; picking it works the same
 * either way, instantly and without an AI call.
 *
 * A reference entry is dropped when the household already owns that product
 * under any spelling — matched on normalized names *and* aliases in both
 * directions. Without that, someone who once created «Помидорки» with the
 * alias «помидоры» would see their own row and the built-in «Помидоры» side
 * by side, and picking the wrong one is exactly the duplicate this whole
 * design exists to prevent.
 *
 * An empty (or whitespace-only) query returns nothing: the sheet shows its
 * suggestions only once there is something to suggest from, rather than
 * dumping the catalog on someone who has not typed yet.
 */
export function searchCatalog({
  query,
  products,
  categories,
  references = REFERENCE_PRODUCTS,
}: SearchCatalogArgs): CatalogSearchHit[] {
  const normalizedQuery = normalizeProductName(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const ranked: RankedHit[] = [];
  // Every spelling the household already owns — names and aliases alike.
  const owned = new Set<string>();

  for (const product of products) {
    owned.add(normalizeProductName(product.name));
    for (const alias of product.aliases) {
      owned.add(normalizeProductName(alias));
    }

    const rank = rankEntry(product.name, product.aliases, normalizedQuery);
    if (rank !== NO_MATCH) {
      ranked.push({
        hit: { source: "catalog", product },
        rank,
        name: normalizeProductName(product.name),
        sourceOrder: 0,
      });
    }
  }

  for (const ref of references) {
    const collides =
      owned.has(normalizeProductName(ref.name)) ||
      ref.aliases.some((alias) => owned.has(normalizeProductName(alias)));
    if (collides) {
      continue;
    }

    const rank = rankEntry(ref.name, ref.aliases, normalizedQuery);
    if (rank === NO_MATCH) {
      continue;
    }

    const categoryId = resolveCategoryIdForSlug(ref.categorySlug, categories);
    if (categoryId === null) {
      // A household with no departments at all cannot receive a product;
      // offering the row would only produce an error on tap.
      continue;
    }

    ranked.push({
      hit: { source: "reference", ref, categoryId },
      rank,
      name: normalizeProductName(ref.name),
      sourceOrder: 1,
    });
  }

  ranked.sort(
    (a, b) =>
      // 1. Match quality.
      a.rank - b.rank ||
      // 2. The household's own catalog wins ties: it is the row that already
      //    exists, and picking it can never create a near-duplicate.
      a.sourceOrder - b.sourceOrder ||
      // 3. Shorter name first — «Помидоры» above «Помидоры черри» for «пом»,
      //    which is both DESIGN_BRIEF S4's example order and the more likely
      //    intent of a short query.
      a.name.length - b.name.length ||
      // 4. Alphabetical, purely so the order is stable and testable.
      a.name.localeCompare(b.name, "ru"),
  );

  return ranked.slice(0, SEARCH_RESULT_LIMIT).map((entry) => entry.hit);
}

/**
 * The household product a query names outright — its normalized name, or one
 * of its normalized aliases, equal to the normalized query.
 *
 * Two callers: the sheet, to decide whether «Создать „…“» is worth offering,
 * and `product.create`, to answer a repeat "create" with the existing row
 * instead of paying for an AI call and then losing to the unique index.
 */
export function findExactMatch(
  query: string,
  products: readonly CatalogProduct[],
): CatalogProduct | null {
  const normalizedQuery = normalizeProductName(query);
  if (normalizedQuery.length === 0) {
    return null;
  }

  return (
    products.find(
      (product) =>
        normalizeProductName(product.name) === normalizedQuery ||
        product.aliases.some(
          (alias) => normalizeProductName(alias) === normalizedQuery,
        ),
    ) ?? null
  );
}

/**
 * The reference-catalog entry a query names outright. `product.create` with
 * `source: "reference"` re-resolves the entry through this rather than
 * trusting an icon and a department sent by the client.
 */
export function findReferenceProduct(
  query: string,
  references: readonly ReferenceProduct[] = REFERENCE_PRODUCTS,
): ReferenceProduct | null {
  const normalizedQuery = normalizeProductName(query);
  if (normalizedQuery.length === 0) {
    return null;
  }

  return (
    references.find(
      (ref) =>
        normalizeProductName(ref.name) === normalizedQuery ||
        ref.aliases.some(
          (alias) => normalizeProductName(alias) === normalizedQuery,
        ),
    ) ?? null
  );
}
