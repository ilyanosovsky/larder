import { describe, expect, it } from "vitest";

import {
  removePantryRow,
  restorePantryRow,
} from "@/lib/pantry/optimistic-remove";

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

  it("is idempotent when the row already came back before the rollback ran", () => {
    // A refetch (a manual «Обновить», or a mount past staleTime — the passive
    // triggers this screen mutes are not the only source of one) restored the
    // row from the server's own list before this rollback got to it.
    // Reinserting on top would leave two rows sharing one id.
    const list = [BUTTER, MILK, EGGS];
    const snapshot = { row: MILK, index: 1 };

    expect(restorePantryRow(list, snapshot)).toEqual([BUTTER, MILK, EGGS]);
  });

  it("matches the already-present row by id, not by object identity", () => {
    // The row that came back from a refetch is a different object than the
    // one this snapshot is holding, even though it describes the same
    // product — the guard has to compare by id.
    const serverMilk: Row = { id: "milk", name: "Молоко" };
    const list = [BUTTER, serverMilk, EGGS];
    const staleSnapshot = { row: MILK, index: 1 };

    expect(restorePantryRow(list, staleSnapshot)).toEqual([
      BUTTER,
      serverMilk,
      EGGS,
    ]);
  });

  it("does not mutate the list on the idempotent path either", () => {
    const list = [BUTTER, MILK];
    restorePantryRow(list, { row: MILK, index: 0 });

    expect(list).toEqual([BUTTER, MILK]);
  });
});
