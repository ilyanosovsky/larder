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
 * must not light up the whole list. From the second call on, this is
 * `diffListSnapshot(state.snapshot, next)`'s added/updated ids, unioned —
 * *unless that diff is empty*, in which case this returns `state` itself,
 * unchanged, same reference (see below).
 *
 * That empty-diff case is not a corner case — it is the **common** one.
 * `cart.list` rows carry a `Date`, and every refetch — the 45s poll, a focus
 * event under `refetchOnWindowFocus: "always"` — hands back a freshly
 * superjson-deserialized array with brand-new `Date` instances, even when
 * the underlying data has not moved a byte. `useChangedRows` therefore calls
 * this on effectively every refetch, changed or not, and a caller must be
 * able to tell "nothing changed" apart from "something changed but happens
 * to net out to an empty set" by reference: returning `state` unchanged lets
 * it skip the `setState`/timer-reset it would otherwise redo on every no-op
 * poll — which, left unguarded, would clear an in-progress highlight (and
 * cancel its timer) well before `HIGHLIGHT_MS`, on the very refetch that
 * follows the one that started it.
 *
 * Reusing `state` also means an empty diff does **not** advance `snapshot`
 * to `next`. That is safe rather than merely convenient: `diffListSnapshot`
 * only ever reports on ids present in whichever array it is handed as
 * `next`, so a row that disappeared between the stale `state.snapshot` and
 * the real `next` is invisible either way, and no id is ever reused once
 * removed (cart items are hard-deleted; a re-added product gets a fresh
 * uuid) — so diffing a future snapshot against this stale one is exactly as
 * accurate as diffing it against the discarded, up-to-date one would have
 * been.
 *
 * "Latest diff wins" under rapid refetches — each call looks only at
 * `state.snapshot`, never at a previously highlighted id — therefore holds
 * for **non-empty** diffs specifically: an empty one is defined to change
 * nothing at all, on purpose.
 */
export function nextHighlightState(
  state: ChangedRowsState,
  next: readonly SyncRow[],
): ChangedRowsState {
  if (state.snapshot === undefined) {
    return { snapshot: next, changedIds: new Set() };
  }

  const diff = diffListSnapshot(state.snapshot, next);
  if (diff.addedIds.size === 0 && diff.updatedIds.size === 0) {
    return state;
  }

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
