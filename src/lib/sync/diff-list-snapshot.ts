/**
 * The fields the diff engine needs from a row. `cart.list`'s items satisfy
 * this structurally — no cast required at the call site.
 */
export interface SyncRow {
  id: string;
  updatedAt: Date;
}

export interface ListDiff {
  /** Ids present in `next` but not `prev`. */
  addedIds: Set<string>;
  /** Ids present in both, whose `updatedAt` moved. */
  updatedIds: Set<string>;
}

/**
 * Compares two refetches of the same list and reports which rows are new or
 * changed — the decision half of the «мягкая подсветка» a screen applies
 * after a refetch (VISION §6.3, mockup 1b). Pure: no timers, no DOM, so the
 * highlight *logic* can be fully covered without rendering anything (see
 * `useChangedRows` for why that split matters here).
 *
 * Rows present in `prev` but missing from `next` are not reported at all —
 * a removed row just disappears from the list; there is nothing to
 * highlight it *as*.
 *
 * Timestamps are compared with `getTime()`, so two `Date` instances that
 * happen to name the same instant (as arrive from two independent
 * superjson-deserialized responses) count as unchanged.
 */
export function diffListSnapshot(
  prev: readonly SyncRow[],
  next: readonly SyncRow[],
): ListDiff {
  const prevById = new Map(prev.map((row) => [row.id, row]));
  const addedIds = new Set<string>();
  const updatedIds = new Set<string>();

  for (const row of next) {
    const previous = prevById.get(row.id);
    if (previous === undefined) {
      addedIds.add(row.id);
    } else if (previous.updatedAt.getTime() !== row.updatedAt.getTime()) {
      updatedIds.add(row.id);
    }
  }

  return { addedIds, updatedIds };
}
