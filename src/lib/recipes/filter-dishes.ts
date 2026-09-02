import { normalizeProductName } from "@/server/catalog/normalize";

/**
 * S6's search box and tag chips (DESIGN_BRIEF S6), as pure functions.
 *
 * **Filtering is client-side and `dish.list` takes no input.** A household
 * has tens of dishes, so one cache entry serves the whole screen: every
 * keystroke re-filters an array instead of issuing a request, which is why S6
 * needs no debounce and works with a dead connection. The documented
 * threshold is ~200 dishes, at which point these functions become the pure
 * half of a `dish.search` endpoint mirroring `product.search` — the shape is
 * already right for that.
 */

/** The two fields the filter reads; a `dish.list` row satisfies it. */
export interface FilterableDish {
  title: string;
  tags: readonly string[];
}

export interface DishFilter {
  /** The raw search box contents. Blank means "no query". */
  query: string;
  /** The selected chip, or `null` for «все» — a UI concept, never a tag. */
  tag: string | null;
}

/**
 * Dishes matching both halves of the filter, in the order they arrived.
 *
 * The query is matched against the title **and** the tags: typing «духовка»
 * finds the same dishes the chip does, which is what stops the two controls
 * from feeling like separate systems. Comparison runs through
 * `normalizeProductName` — the catalog's canon — so «Оладьи» is found by
 * «оладьи» and «тёплое» by «теплое».
 *
 * Order is preserved rather than re-sorted by relevance: S6 is a grid ordered
 * newest-first, and cards jumping around under a typing finger is the exact
 * thing DESIGN_BRIEF §6 asks not to do.
 */
export function filterDishes<TDish extends FilterableDish>(
  dishes: readonly TDish[],
  filter: DishFilter,
): TDish[] {
  const query = normalizeProductName(filter.query);
  const tag = filter.tag === null ? null : normalizeProductName(filter.tag);

  return dishes.filter((dish) => {
    if (
      tag !== null &&
      !dish.tags.some((value) => normalizeProductName(value) === tag)
    ) {
      return false;
    }

    if (query.length === 0) {
      return true;
    }

    return (
      normalizeProductName(dish.title).includes(query) ||
      dish.tags.some((value) => normalizeProductName(value).includes(query))
    );
  });
}

/**
 * The chip row: every tag in the library, most-used first, then alphabetical.
 *
 * Frequency first because the chips are a shortcut, and the tag a household
 * uses on half its dishes is the one worth reaching without scrolling;
 * alphabetical is the tiebreak so the row does not reshuffle when two tags
 * draw level.
 *
 * **«все» is not in the result.** It is a UI state (`tag: null`), not a tag —
 * a dish tagged «все» would otherwise be indistinguishable from no filter at
 * all.
 *
 * Tags are already canonical on the way in (`normalizeTags` runs on every
 * save), so they are counted by their stored value and displayed verbatim.
 */
export function collectTags(dishes: readonly FilterableDish[]): string[] {
  const counts = new Map<string, number>();

  for (const dish of dishes) {
    for (const tag of dish.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(([leftTag, leftCount], [rightTag, rightCount]) =>
      leftCount === rightCount
        ? leftTag.localeCompare(rightTag, "ru")
        : rightCount - leftCount,
    )
    .map(([tag]) => tag);
}
