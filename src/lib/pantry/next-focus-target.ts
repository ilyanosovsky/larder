/** The one field the decision needs; a `pantry.list` row satisfies it. */
export interface FocusableRow {
  id: string;
}

/**
 * Where keyboard focus should land after «Кончилось» removes `removedId`'s
 * row from the list.
 *
 * A tapped «Кончилось» button is the row's own — and, in the common case,
 * the *currently focused* — element, and that row unmounts the instant the
 * optimistic removal (`removePantryRow`) lands. A browser does not pick a
 * sensible neighbour for a focused element that disappears; it drops focus
 * to `<body>`, and from there a keyboard shopper's next Tab starts over from
 * the top of the page instead of continuing where they were.
 *
 * `items` is the list **before** the removal — the row still at `removedId`
 * is what "next"/"previous" are relative to. Deliberately a flat walk, not
 * per-department: a department can run out down to its last product, and the
 * next sensible landing spot is simply whatever row is visually adjacent,
 * department boundary or not — the same reason `groupProductsByCategory`
 * itself only ever *reads* this order rather than one this function would
 * have to re-derive.
 *
 * Returns `null` when there is nothing else to land on — `removedId` was the
 * only row, or (defensively) was not found in `items` at all — so the caller
 * knows to fall back to a container-level target instead of doing nothing.
 */
export function pickNextFocusTarget<TRow extends FocusableRow>(
  items: readonly TRow[],
  removedId: string,
): string | null {
  const index = items.findIndex((item) => item.id === removedId);
  if (index === -1) {
    return null;
  }

  return items[index + 1]?.id ?? items[index - 1]?.id ?? null;
}
