import { describe, expect, it } from "vitest";

import { removePantryRow, restorePantryRow } from "@/lib/pantry/optimistic-remove";

interface Row {
  id: string;
  name: string;
}

const BUTTER: Row = { id: "butter", name: "Масло" };
const MILK: Row = { id: "milk", name: "Молоко" };
const EGGS: Row = { id: "eggs", name: "Яйца" };

describe("removePantryRow", () => {
  it("removes the row with the given id", () => {
    const result = removePantryRow([BUTTER, MILK, EGGS], "milk");

    expect(result.list).toEqual([BUTTER, EGGS]);
    expect(result.snapshot).toEqual({ row: MILK, index: 1 });
  });

  it("does not mutate the list it was given", () => {
    const original = [BUTTER, MILK, EGGS];
    removePantryRow(original, "milk");

    expect(original).toEqual([BUTTER, MILK, EGGS]);
  });

  it("is a no-op with a null snapshot when the row is not there", () => {
    // A refetch already removed it out from under the tap — not an error,
    // the same idea `applyStatusToggle` (`src/lib/cart/status-toggle.ts`)
    // treats a missing row.
    const result = removePantryRow([BUTTER, MILK], "eggs");

    expect(result.list).toEqual([BUTTER, MILK]);
    expect(result.snapshot).toBeNull();
  });

  it("still returns a fresh array on a no-op — never the same reference", () => {
    const original = [BUTTER, MILK];
    const result = removePantryRow(original, "eggs");

    expect(result.list).not.toBe(original);
  });
});

describe("restorePantryRow", () => {
  it("puts the row back at the index it came from", () => {
    const { list, snapshot } = removePantryRow([BUTTER, MILK, EGGS], "milk");
    expect(snapshot).not.toBeNull();

    expect(restorePantryRow(list, snapshot!)).toEqual([BUTTER, MILK, EGGS]);
  });

  it("restores the first row correctly", () => {
    const { list, snapshot } = removePantryRow([BUTTER, MILK], "butter");
    expect(snapshot).not.toBeNull();

    expect(restorePantryRow(list, snapshot!)).toEqual([BUTTER, MILK]);
  });

  it("clamps a stale index rather than throwing when the list shrank further", () => {
    // Another row was removed (and not yet rolled back) between the snapshot
    // being taken and this rollback running.
    const stale = restorePantryRow([BUTTER], { row: EGGS, index: 5 });

    expect(stale).toEqual([BUTTER, EGGS]);
  });

  it("does not mutate the list it was given", () => {
    const list = [BUTTER];
    restorePantryRow(list, { row: MILK, index: 0 });

    expect(list).toEqual([BUTTER]);
  });
});
