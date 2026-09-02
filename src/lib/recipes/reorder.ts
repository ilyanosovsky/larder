/**
 * Reordering a recipe's steps, decided in a pure function so the two ways of
 * doing it cannot disagree (DESIGN_BRIEF S8.3: «шаги списком с
 * перетаскиванием»).
 *
 * S8.3 offers both a `≡` drag handle and «Выше»/«Ниже» buttons — HTML5 drag
 * and drop does not work on iOS, and a drag is unusable with a keyboard, so
 * neither on its own is enough. What makes them one feature rather than two
 * is that both end in `moveItem` with an index: the pointer path only has to
 * work out *which* index (`stepDropIndex`), and that decision is geometry, not
 * DOM.
 *
 * No React, no DOM, no `PointerEvent` — the same split `swipe-commit.ts` draws
 * for the pantry's swipe.
 */

/**
 * `list` with the item at `from` moved to `to`, both clamped into range.
 *
 * A copy, never a mutation: the array is React state, and splicing it in place
 * would leave the component rendering the same reference it already rendered.
 * `from === to` still returns a fresh array — harmless, and it keeps the
 * function total instead of having two kinds of answer.
 */
export function moveItem<TItem>(
  list: readonly TItem[],
  from: number,
  to: number,
): TItem[] {
  const next = [...list];
  if (next.length === 0) {
    return next;
  }

  const source = clampIndex(from, next.length);
  const target = clampIndex(to, next.length);

  const [item] = next.splice(source, 1);
  if (item === undefined) {
    return [...list];
  }
  next.splice(target, 0, item);

  return next;
}

/** Where the top edge of a row sits, and how tall it is. */
export interface RowRect {
  readonly top: number;
  readonly height: number;
}

/**
 * The index a dragged step should land at, given where the pointer is, where
 * the rows are, and which row is being dragged.
 *
 * The rule is "how many rows has the pointer passed the middle of": a row is
 * swapped only once the finger is properly past its midpoint, which is what
 * keeps a list from flickering back and forth under a hovering thumb.
 *
 * **The two index spaces are why `from` is a parameter.** Counting midpoints
 * yields a *gap* index in `0..rects.length`, measured on the list as it looks
 * now — with the dragged row still in it. `moveItem` removes the row first and
 * inserts into the shortened list, so every gap below the dragged row is
 * unchanged while every gap above it has shifted down by one. Converting here
 * rather than at the call site keeps the whole decision in one tested pure
 * function: without it, a drag downwards lands one slot too low and a release
 * that never left the dragged row's own box still reorders the list.
 *
 * `rects` are the rows **in visual order**, including the dragged one.
 */
export function stepDropIndex(
  pointerY: number,
  rects: readonly RowRect[],
  from: number,
): number {
  if (rects.length === 0) {
    return 0;
  }

  // The gap the pointer sits in, 0..rects.length — deliberately **not**
  // clamped to `length - 1`: a release below the last row belongs in the gap
  // past the end, and clamping it here would collapse it onto the gap above.
  let gap = 0;
  for (const rect of rects) {
    if (pointerY >= rect.top + rect.height / 2) {
      gap += 1;
    }
  }

  const source = clampIndex(from, rects.length);
  return gap > source
    ? clampIndex(gap - 1, rects.length)
    : clampIndex(gap, rects.length);
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) {
    // `NaN` propagates through `Math.min`/`Math.max` instead of clamping, and
    // a `NaN` index would silently drop the item out of the list.
    return 0;
  }
  return Math.min(Math.max(Math.trunc(value), 0), length - 1);
}
