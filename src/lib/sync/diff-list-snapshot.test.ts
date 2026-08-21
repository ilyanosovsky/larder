import { describe, expect, it } from "vitest";

import { diffListSnapshot, type SyncRow } from "./diff-list-snapshot";

function row(id: string, updatedAtMs: number): SyncRow {
  return { id, updatedAt: new Date(updatedAtMs) };
}

describe("diffListSnapshot", () => {
  it("reports a row present only in next as added", () => {
    const diff = diffListSnapshot([], [row("a", 0)]);

    expect(diff.addedIds).toEqual(new Set(["a"]));
    expect(diff.updatedIds).toEqual(new Set());
  });

  it("reports a row whose updatedAt moved as updated, not added", () => {
    const diff = diffListSnapshot([row("a", 0)], [row("a", 1000)]);

    expect(diff.addedIds).toEqual(new Set());
    expect(diff.updatedIds).toEqual(new Set(["a"]));
  });

  it("does not report a row missing from next at all", () => {
    const diff = diffListSnapshot([row("a", 0), row("b", 0)], [row("a", 0)]);

    expect(diff.addedIds).toEqual(new Set());
    expect(diff.updatedIds).toEqual(new Set());
  });

  it("returns empty sets for two empty snapshots", () => {
    const diff = diffListSnapshot([], []);

    expect(diff.addedIds).toEqual(new Set());
    expect(diff.updatedIds).toEqual(new Set());
  });

  it("treats every row as added on a first load (empty prev)", () => {
    const diff = diffListSnapshot([], [row("a", 0), row("b", 0)]);

    expect(diff.addedIds).toEqual(new Set(["a", "b"]));
    expect(diff.updatedIds).toEqual(new Set());
  });

  it("does not flag a row whose updatedAt is unchanged, even as a distinct Date instance", () => {
    const diff = diffListSnapshot([row("a", 1_000)], [row("a", 1_000)]);

    expect(diff.addedIds).toEqual(new Set());
    expect(diff.updatedIds).toEqual(new Set());
  });

  it("handles added, updated and removed rows together in one diff", () => {
    const prev = [row("a", 0), row("b", 0), row("c", 0)];
    // a: unchanged, b: removed, c: updated, d: added
    const next = [row("a", 0), row("c", 500), row("d", 0)];

    const diff = diffListSnapshot(prev, next);

    expect(diff.addedIds).toEqual(new Set(["d"]));
    expect(diff.updatedIds).toEqual(new Set(["c"]));
  });
});
