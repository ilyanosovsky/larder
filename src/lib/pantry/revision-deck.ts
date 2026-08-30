/**
 * The fields one revision card needs to show — a `pantry.list` row satisfies
 * this structurally, but the deck only ever remembers this pared-down shape
 * (see `buildRevisionDeck`), never a live reference into the query cache.
 */
export interface RevisionCard {
  id: string;
  productName: string;
  productIcon: string;
  categoryName: string;
}

export type RevisionDecision = "have" | "ranOut";

/**
 * A stable snapshot of the pantry list at the moment «Ревизия» opens
 * (DESIGN_BRIEF S5) — deliberately a plain array copy, not something derived
 * fresh from `pantry.list`'s query cache on every render. A refetch
 * (background poll, focus regain, a partner's own tap) while the mode is
 * running must not reshuffle or grow the deck mid-run: what the shopper is
 * walking through is "the pantry as it stood the moment I started", and a
 * partner's addition simply isn't part of this session — it'll be there the
 * next time «Ревизия» opens.
 *
 * A fresh array **and a fresh object per row** — `items.map((item) => ({
 * ...item }))`, not `[...items]` — for the same defensive reason either way:
 * nothing in this app currently mutates a query's cached row in place, but a
 * deck holding the exact same object references the query cache has would
 * make that bug easy to introduce later (on either side — a mutation to the
 * cached row leaking into the still-running deck, or vice versa) without
 * this function's own tests noticing. The caller (`revision-mode.tsx`)
 * additionally takes this snapshot inside a lazy `useState` initializer, so
 * even a parent that re-renders with a fresh `items` reference mid-run (a
 * live refetch landing behind the overlay) cannot feed a second snapshot in
 * — the deck is built exactly once per run.
 */
export function buildRevisionDeck<TItem extends RevisionCard>(
  items: readonly TItem[],
): readonly TItem[] {
  return items.map((item) => ({ ...item }));
}

/** Where a run stands, after `index` cards have been decided. */
export interface RevisionState {
  readonly index: number;
  /** Ids decided «кончилось» this run, in the order they were decided — the
   * summary screen's count is this array's length, not a running tally kept
   * anywhere else. */
  readonly ranOutIds: readonly string[];
}

export const initialRevisionState: RevisionState = {
  index: 0,
  ranOutIds: [],
};

/**
 * Advances past the card at `state.index`, recording `id` when the decision
 * was «кончилось».
 *
 * Takes `id` explicitly rather than trusting `state.index` to still name the
 * right card: the caller reads `id` off the very card it is deciding on
 * (`deck[state.index]`) before calling this, so a mismatch here would only
 * ever come from a bug in the caller — and `id`, not the index, is what the
 * summary (and any future per-decision undo) needs to key on.
 */
export function decideRevisionCard(
  state: RevisionState,
  id: string,
  decision: RevisionDecision,
): RevisionState {
  return {
    index: state.index + 1,
    ranOutIds:
      decision === "ranOut" ? [...state.ranOutIds, id] : state.ranOutIds,
  };
}

export interface RevisionProgress {
  /** 1-based position of the card on screen — clamped to `total` so a run
   * that has just finished never reports "35 из 34". */
  readonly current: number;
  readonly total: number;
  readonly finished: boolean;
}

/**
 * DESIGN_BRIEF's «12 из 34». `total` is the deck's own fixed length
 * (`buildRevisionDeck`'s result, taken once at open), so this reads honestly
 * throughout the run regardless of anything happening to the live
 * `pantry.list` behind the overlay.
 */
export function revisionProgress(
  state: RevisionState,
  total: number,
): RevisionProgress {
  return {
    current: Math.min(state.index + 1, total),
    total,
    finished: state.index >= total,
  };
}

export type RevisionSummary =
  { kind: "empty" } | { kind: "counted"; count: number };

/**
 * The exit screen's headline (DESIGN_BRIEF S5: «Готово: 3 продукта улетели в
 * корзину»). Split into a discriminated `kind` rather than always returning
 * `{ count }`, because a run where nothing ran out needs its own «всё на
 * месте» flavor of copy (called out explicitly in the task brief) — a
 * template that just plugs `0` into the same ICU plural would read as
 * «Готово: 0 продуктов улетело в корзину», technically true but the wrong
 * tone for "you checked the whole pantry and it's all still there".
 */
export function summarizeRevision(state: RevisionState): RevisionSummary {
  return state.ranOutIds.length === 0
    ? { kind: "empty" }
    : { kind: "counted", count: state.ranOutIds.length };
}
