import { diffListSnapshot, type SyncRow } from "./diff-list-snapshot";

/**
 * `useChangedRows`'s entire state, factored out so the transitions below are
 * plain functions instead of `useState`/`useRef` calls: vitest here runs in
 * a **node** environment and only collects `src/**\/*.test.ts` (not `.tsx`),
 * so a hook itself cannot be rendered or tested. Every branch that decides
 * *what* changes lives here; the hook is left with nothing but a ref, a
 * `setState`, and a timer.
 */
export interface ChangedRowsState {
  /**
   * The last snapshot the diff engine has seen, or `undefined` before the
   * first one has arrived. `undefined` — not `[]` — is what lets
   * `nextHighlightState` tell "nothing to compare against yet" apart from
   * "compared against a list that happened to be empty".
   */
  readonly snapshot: readonly SyncRow[] | undefined;
  readonly changedIds: ReadonlySet<string>;
}

/** Before any snapshot has arrived: nothing to diff, nothing highlighted. */
export const INITIAL_HIGHLIGHT_STATE: ChangedRowsState = {
  snapshot: undefined,
  changedIds: new Set(),
};

/**
 * Folds a freshly arrived snapshot into the running state.
 *
 * The first-ever call (`state.snapshot === undefined`) never highlights
 * anything — every row is technically "added" relative to nothing, but a
 * first load is not a change a user made while looking at the screen, so it
 * must not light up the whole list. From the second call on, this is exactly
 * `diffListSnapshot(state.snapshot, next)`'s added/updated ids, unioned.
 *
 * Each call is independent of any earlier `changedIds` — it only looks at
 * `state.snapshot`, never at what was previously highlighted. That is what
 * gives "latest diff wins" under rapid refetches: calling this twice in a
 * row before a highlight timer clears simply recomputes from scratch against
 * the newer snapshot, rather than accumulating ids across both diffs.
 */
export function nextHighlightState(
  state: ChangedRowsState,
  next: readonly SyncRow[],
): ChangedRowsState {
  if (state.snapshot === undefined) {
    return { snapshot: next, changedIds: new Set() };
  }

  const diff = diffListSnapshot(state.snapshot, next);
  const changedIds = new Set([...diff.addedIds, ...diff.updatedIds]);
  return { snapshot: next, changedIds };
}

/**
 * The state once the highlight window (`HIGHLIGHT_MS`) elapses: the same
 * snapshot — the next diff still needs something to compare against — with
 * `changedIds` cleared.
 *
 * A no-op (returns `state` unchanged, same reference) once `changedIds` is
 * already empty, so the hook's timer callback can call this unconditionally
 * without tracking whether it already fired or a newer diff already cleared
 * it first.
 */
export function clearHighlight(state: ChangedRowsState): ChangedRowsState {
  if (state.changedIds.size === 0) {
    return state;
  }
  return { snapshot: state.snapshot, changedIds: new Set() };
}
