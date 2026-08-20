import {
  DEFAULT_CATEGORIES,
  type DefaultCategorySlug,
} from "@/server/catalog/default-categories";
import { normalizeProductName } from "@/server/catalog/normalize";

/** The shape both the search and the product router read categories in. */
export interface HouseholdCategory {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

/**
 * The department a new product lands in when nothing better is known — the
 * one fallback shared by the reference catalog and the AI enrichment path.
 *
 * «Бакалея» is the deliberate default: it is where a Russian shopper expects
 * an unclassified dry good, and it is the department least likely to look
 * absurd for something we could not place. If the household renamed or
 * deleted it, the first department by walking order is the next best guess.
 *
 * Returns `null` only for a household with no departments at all —
 * impossible in practice (`household.create` seeds seven), but the caller
 * decides what to do about it rather than this function inventing an id.
 */
export function fallbackCategoryId(
  categories: readonly HouseholdCategory[],
): string | null {
  const groceryName = categoryNameForSlug("grocery");
  const grocery = categories.find(
    (category) =>
      normalizeProductName(category.name) === normalizeProductName(groceryName),
  );
  if (grocery) {
    return grocery.id;
  }

  const first = [...categories].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  )[0];
  return first?.id ?? null;
}

/**
 * Maps a reference product's `categorySlug` onto the household's own
 * department row.
 *
 * The link is the **name**: `categories` rows are created from
 * `DEFAULT_CATEGORIES` and carry no slug column, on purpose — a household may
 * rename, reorder or (task 7.1) delete its departments, and a stored slug
 * would then be a lie. A household that renamed «Бакалея» simply stops
 * matching and gets the fallback above, which is the honest answer.
 */
export function resolveCategoryIdForSlug(
  slug: DefaultCategorySlug,
  categories: readonly HouseholdCategory[],
): string | null {
  const wanted = normalizeProductName(categoryNameForSlug(slug));
  const match = categories.find(
    (category) => normalizeProductName(category.name) === wanted,
  );

  return match?.id ?? fallbackCategoryId(categories);
}

function categoryNameForSlug(slug: DefaultCategorySlug): string {
  const found = DEFAULT_CATEGORIES.find((category) => category.slug === slug);
  // DEFAULT_CATEGORIES covers every slug in DefaultCategorySlug by
  // construction; the fallback keeps this total instead of asserting.
  return found?.name ?? slug;
}
