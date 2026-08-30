/** The one field the removal needs; a `pantry.list` row satisfies it. */
export interface RemovablePantryRow {
  id: string;
}

/** What `onMutate` needs to hand `onError`, to undo exactly this row. */
export interface PantryRemovalSnapshot<TRow> {
  row: TRow;
  /** Where it sat in the list, so a rollback reinserts it in place rather
   * than tacking it onto the end and jumping it across department sections. */
  index: number;
}

export interface PantryRemoval<TRow> {
  list: TRow[];
  /** `null` when the row was already gone from the cache — nothing to undo. */
  snapshot: PantryRemovalSnapshot<TRow> | null;
}

/**
 * The optimistic half of «Кончилось»: the cached `pantry.list` with one row
 * removed, for `queryClient.setQueryData` inside `onMutate` — the pantry
 * counterpart of `applyStatusToggle` (`src/lib/cart/status-toggle.ts`), shaped
 * as a removal instead of a field patch because a pantry row's whole
 * lifecycle *is* presence or absence (VISION §3.2).
 *
 * Returns the snapshot alongside the new list, not just the list, because
 * `onError`'s rollback has no other way to know *where* the row belongs —
 * appending it at the end would jump it across a department-section boundary
 * `groupProductsByCategory` draws from list order, the same reason
 * `sortBoughtLast` is careful to sort *within* a section rather than the flat
 * list.
 */
export function removePantryRow<TRow extends RemovablePantryRow>(
  list: readonly TRow[],
  id: string,
): PantryRemoval<TRow> {
  const index = list.findIndex((row) => row.id === id);
  if (index === -1) {
    return { list: [...list], snapshot: null };
  }

  return {
    list: [...list.slice(0, index), ...list.slice(index + 1)],
    snapshot: { row: list[index] as TRow, index },
  };
}

/**
 * Undoes exactly the row `removePantryRow` took out, at the position it came
 * from — never a whole-list snapshot restore, for the same reason the cart
 * checkbox's rollback is per row: an unrelated «Кончилось» tap landing on a
 * different row while this one is in flight must survive it.
 *
 * `index` is clamped to the current list length: the list may have shrunk
 * further (another row removed) or grown (a refetch landed) since this
 * snapshot was taken, and a stale index must degrade to "put it back at the
 * end" rather than throw or silently drop the row.
 *
 * **Idempotent when the row is already back.** A rollback runs some time
 * after the tap — after the mutation has actually failed — and in that
 * window a refetch (the passive triggers this screen mutes are not the only
 * source of one: a manual «Обновить», or a mount that lands past
 * `staleTime`, both still fire) can already have restored the row from the
 * server's own list, which never lost it. Reinserting on top of that would
 * leave two rows sharing one id — a duplicate `<li key>` and the product
 * shown twice until the next refetch quietly heals it. Checked by id rather
 * than by reference, because the row that came back from the server is a
 * different object than the one this snapshot is holding.
 */
export function restorePantryRow<TRow extends RemovablePantryRow>(
  list: readonly TRow[],
  snapshot: PantryRemovalSnapshot<TRow>,
): TRow[] {
  if (list.some((row) => row.id === snapshot.row.id)) {
    return [...list];
  }

  const index = Math.min(snapshot.index, list.length);
  return [...list.slice(0, index), snapshot.row, ...list.slice(index)];
}
