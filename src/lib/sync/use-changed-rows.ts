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
 * (VISION §6.3). `items` is expected to be a tRPC `useQuery(...).data` —
 * `undefined` while pending is a no-op, not a snapshot.
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

    stateRef.current = nextHighlightState(stateRef.current, items);
    setChangedIds(stateRef.current.changedIds);

    if (timerRef.current !== undefined) {
      // A newer snapshot arrived before the previous highlight expired —
      // the timer is restarted below, so "latest diff wins" instead of the
      // stale one clearing mid-window.
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (stateRef.current.changedIds.size === 0) {
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
