import type { CartItemStatus } from "@/server/cart/merge";

/**
 * The one field the sort looks at. A `cart.list` row satisfies this
 * structurally — no cast at the call site.
 */
export interface SortableCartRow {
  status: CartItemStatus;
}

/**
 * Sinks bought lines to the bottom of the list they are in — DESIGN_BRIEF S3's
 * «строка зачёркивается и опускается вниз секции».
 *
 * Applied **per section**, after `groupProductsByCategory` has cut the list
 * up, never before it: that function starts a new section every time the
 * department changes as it walks, so reordering the flat list first would move
 * a bought row across a department boundary and split its department into two
 * sections.
 *
 * A stable partition rather than a comparator sort. Within each half the
 * server's own walking order (department `sortOrder`, then product name)
 * survives untouched, which is what keeps a row from also jumping sideways
 * among its neighbours the moment someone ticks a different one.
 */
export function sortBoughtLast<TRow extends SortableCartRow>(
  items: readonly TRow[],
): TRow[] {
  const open: TRow[] = [];
  const bought: TRow[] = [];

  for (const item of items) {
    // `ordered` belongs with `needed`: it is still something to receive, so it
    // stays in the live half of the section (VISION §3.1).
    if (item.status === "bought") {
      bought.push(item);
    } else {
      open.push(item);
    }
  }

  return [...open, ...bought];
}
