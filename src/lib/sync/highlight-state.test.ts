import { describe, expect, it } from "vitest";

import type { SyncRow } from "./diff-list-snapshot";
import {
  clearHighlight,
  INITIAL_HIGHLIGHT_STATE,
  nextHighlightState,
} from "./highlight-state";

function row(id: string, updatedAtMs: number): SyncRow {
  return { id, updatedAt: new Date(updatedAtMs) };
}

describe("nextHighlightState", () => {
  it("marks nothing changed on the very first snapshot", () => {
    const state = nextHighlightState(INITIAL_HIGHLIGHT_STATE, [
      row("a", 0),
      row("b", 0),
    ]);

    expect(state.changedIds).toEqual(new Set());
    expect(state.snapshot).toEqual([row("a", 0), row("b", 0)]);
  });

  it("sets changedIds to the diff's added+updated ids from the second snapshot on", () => {
    const first = nextHighlightState(INITIAL_HIGHLIGHT_STATE, [
      row("a", 0),
      row("b", 0),
    ]);

    // a: unchanged, b: removed, c: added
    const second = nextHighlightState(first, [row("a", 0), row("c", 0)]);

    expect(second.changedIds).toEqual(new Set(["c"]));
  });

  it("reflects an updated timestamp as a change", () => {
    const first = nextHighlightState(INITIAL_HIGHLIGHT_STATE, [row("a", 0)]);
    const second = nextHighlightState(first, [row("a", 1000)]);

    expect(second.changedIds).toEqual(new Set(["a"]));
  });

  it("does not accumulate ids across rapid, successive diffs — the latest wins", () => {
    const first = nextHighlightState(INITIAL_HIGHLIGHT_STATE, [row("a", 0)]);
    // a updated -> highlighted
    const second = nextHighlightState(first, [row("a", 1000)]);
    expect(second.changedIds).toEqual(new Set(["a"]));

    // Before any timer would have cleared `second`, another snapshot lands:
    // a unchanged since `second`, b newly added. Only b should be
    // highlighted now — `a` is not carried over from the previous diff.
    const third = nextHighlightState(second, [row("a", 1000), row("b", 0)]);
    expect(third.changedIds).toEqual(new Set(["b"]));
  });
});

describe("clearHighlight", () => {
  it("empties changedIds while keeping the snapshot to diff against next time", () => {
    const highlighted = nextHighlightState(
      nextHighlightState(INITIAL_HIGHLIGHT_STATE, [row("a", 0)]),
      [row("a", 1000)],
    );
    expect(highlighted.changedIds.size).toBeGreaterThan(0);

    const cleared = clearHighlight(highlighted);

    expect(cleared.changedIds).toEqual(new Set());
    expect(cleared.snapshot).toBe(highlighted.snapshot);
  });

  it("is a no-op (same reference) when nothing is highlighted", () => {
    expect(clearHighlight(INITIAL_HIGHLIGHT_STATE)).toBe(
      INITIAL_HIGHLIGHT_STATE,
    );
  });
});
