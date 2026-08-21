"use client";

import { useEffect, useRef, useState } from "react";

import type { SyncRow } from "./diff-list-snapshot";
import {
  clearHighlight,
  INITIAL_HIGHLIGHT_STATE,
  nextHighlightState,
  type ChangedRowsState,
} from "./highlight-state";

/**
 * How long a changed row stays softly highlighted after a refetch, in ms.
 * Mockup 1b's highlight is transient — a cue that something just moved, not
 * a persistent marker — so it clears itself rather than waiting for the next
 * refetch to overwrite it.
 */
export const HIGHLIGHT_MS = 4000;

export interface ChangedRows {
  /** Union of rows added or updated by the most recent refetch, empty once
   * `HIGHLIGHT_MS` has passed (or before the first refetch has landed). */
  readonly changedIds: ReadonlySet<string>;
}

/**
 * Tracks which rows in `items` changed across refetches, for the «мягкая
 * подсветка» a cart-family screen applies after a background sync
 * (VISION §6.3). `items` is expected to be the array reference a tRPC
 * `useQuery(...).data` hands back directly — `undefined` while pending is a
 * no-op, not a snapshot. Do not pass an inline-derived array (e.g.
 * `data?.filter(...)`): a fresh array every render defeats the effect's own
 * `[items]` dependency and forces `nextHighlightState` to redo its diff on
 * every render instead of only on an actual refetch; derive first, memoize
 * (`useMemo`), and pass the memoized result in.
 *
 * This hook is deliberately a thin shell: it owns a ref for the running
 * `ChangedRowsState` and a timer for clearing the highlight, and delegates
 * every actual decision to `nextHighlightState`/`clearHighlight`
 * (`./highlight-state.ts`), which is where the tests live — see that
 * module's doc comment for why.
 */
export function useChangedRows(
  items: readonly SyncRow[] | undefined,
): ChangedRows {
  const stateRef = useRef<ChangedRowsState>(INITIAL_HIGHLIGHT_STATE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(
    () => stateRef.current.changedIds,
  );

  useEffect(() => {
    if (items === undefined) {
      return;
    }

    const result = nextHighlightState(stateRef.current, items);
    if (result === stateRef.current) {
      // `nextHighlightState` returns the same reference when this snapshot
      // changed nothing relative to the last one it diffed against — the
      // common case, since a `Date`-bearing response gets a fresh identity
      // on every refetch regardless of content. Bailing out here, rather
      // than calling `setState`/resetting the timer unconditionally, is
      // what stops that from being either a wasted re-render (plain query
      // data) or an infinite one (a derived array recreated every render)
      // — and, just as importantly, leaves an in-progress highlight and its
      // clear timer running untouched instead of wiping it out early.
      return;
    }

    stateRef.current = result;
    setChangedIds(result.changedIds);

    if (timerRef.current !== undefined) {
      // A newer, *actual* change arrived before the previous highlight
      // expired — the timer is restarted below, so "latest diff wins"
      // instead of the stale one clearing mid-window.
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (result.changedIds.size === 0) {
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      stateRef.current = clearHighlight(stateRef.current);
      setChangedIds(stateRef.current.changedIds);
    }, HIGHLIGHT_MS);
  }, [items]);

  // Unmounting mid-highlight must not leak the timer or fire a setState on
  // an unmounted component.
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return { changedIds };
}
