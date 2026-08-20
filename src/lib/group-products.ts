/**
 * A store department with the products filed under it — one CategorySection
 * (DESIGN_BRIEF §3) as a screen renders it.
 */
export interface ProductSection<TItem> {
  categoryId: string;
  name: string;
  icon: string;
  items: TItem[];
}

/** The fields grouping needs; any `product.list` row satisfies it. */
export interface GroupableProduct {
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
}

/**
 * Cuts an already-ordered product list into department sections.
 *
 * The query returns rows in walking order — department by `sortOrder`, then
 * name — so this walks the run and starts a new section whenever the
 * department changes. Deliberately not a `Map` keyed by department: that
 * would re-derive an order the database already decided, and the two would
 * eventually disagree about which department comes first.
 *
 * A run that revisits a department it already left would therefore produce
 * two sections for it. That is the honest rendering of a list that arrived
 * out of order, and it makes the ordering bug visible instead of hiding it.
 */
export function groupProductsByCategory<TItem extends GroupableProduct>(
  items: readonly TItem[],
): ProductSection<TItem>[] {
  const sections: ProductSection<TItem>[] = [];

  for (const item of items) {
    const current = sections.at(-1);
    if (current && current.categoryId === item.categoryId) {
      current.items.push(item);
      continue;
    }

    sections.push({
      categoryId: item.categoryId,
      name: item.categoryName,
      icon: item.categoryIcon,
      items: [item],
    });
  }

  return sections;
}
