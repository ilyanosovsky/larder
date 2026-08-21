import { describe, expect, it } from "vitest";

import {
  applyReceiveOrder,
  groupOrderedByService,
  receivableServiceGroups,
  rollbackReceiveOrder,
  type OrderedCartRow,
} from "./receive-order";

function row(
  overrides: Partial<OrderedCartRow> & { id: string },
): OrderedCartRow {
  return { status: "needed", orderedVia: null, ...overrides };
}

const MILK = row({ id: "milk", status: "ordered", orderedVia: "wolt" });
const FLOUR = row({ id: "flour", status: "ordered", orderedVia: "carrefour" });
const CANDLES = row({ id: "candles", status: "ordered", orderedVia: "other" });
const LEMONS = row({ id: "lemons", status: "needed" });
const EGGS = row({ id: "eggs", status: "bought" });

describe("applyReceiveOrder", () => {
  it("moves every ordered row to bought and clears its service", () => {
    const { list, snapshots } = applyReceiveOrder([MILK, FLOUR, LEMONS]);

    expect(list).toEqual([
      { ...MILK, status: "bought", orderedVia: null },
      { ...FLOUR, status: "bought", orderedVia: null },
      LEMONS,
    ]);
    expect(snapshots).toEqual([
      { id: "milk", status: "ordered", orderedVia: "wolt" },
      { id: "flour", status: "ordered", orderedVia: "carrefour" },
    ]);
  });

  it("touches only the rows ordered through the given service", () => {
    const { list, snapshots } = applyReceiveOrder([MILK, FLOUR], "wolt");

    expect(list).toEqual([
      { ...MILK, status: "bought", orderedVia: null },
      FLOUR,
    ]);
    expect(snapshots).toEqual([
      { id: "milk", status: "ordered", orderedVia: "wolt" },
    ]);
  });

  it("leaves buyerId-shaped extra fields alone — it never touches anything but status/orderedVia", () => {
    const withBuyer = { ...MILK, buyerId: "user_2" };
    const { list } = applyReceiveOrder([withBuyer]);

    expect(list[0]).toMatchObject({ buyerId: "user_2", status: "bought" });
  });

  it("returns the list itself, unchanged, when nothing is ordered", () => {
    const list = [LEMONS, EGGS];

    const result = applyReceiveOrder(list);

    expect(result.list).toBe(list);
    expect(result.snapshots).toEqual([]);
  });

  it("returns the list itself when the given service has nothing ordered", () => {
    const list = [MILK];

    const result = applyReceiveOrder(list, "carrefour");

    expect(result.list).toBe(list);
    expect(result.snapshots).toEqual([]);
  });
});

describe("rollbackReceiveOrder", () => {
  it("restores exactly the rows a snapshot names", () => {
    const { list, snapshots } = applyReceiveOrder([MILK, FLOUR, LEMONS]);

    expect(rollbackReceiveOrder(list, snapshots)).toEqual([
      MILK,
      FLOUR,
      LEMONS,
    ]);
  });

  it("leaves a row untouched by a later, unrelated change", () => {
    // The bulk analogue of the per-row inverse: a checkbox tick on `lemons`
    // after the bulk receive started must survive the bulk request's rollback.
    const { list, snapshots } = applyReceiveOrder([MILK, LEMONS]);
    const withLaterTick = list.map((row) =>
      row.id === "lemons" ? { ...row, status: "bought" as const } : row,
    );

    const rolledBack = rollbackReceiveOrder(withLaterTick, snapshots);

    expect(rolledBack.find((row) => row.id === "lemons")).toMatchObject({
      status: "bought",
    });
    expect(rolledBack.find((row) => row.id === "milk")).toEqual(MILK);
  });

  it("returns the list itself when there is nothing to restore", () => {
    const list = [MILK];

    expect(rollbackReceiveOrder(list, [])).toBe(list);
  });
});

describe("groupOrderedByService", () => {
  it("counts each service's ordered rows", () => {
    expect(groupOrderedByService([MILK, FLOUR, CANDLES, LEMONS, EGGS])).toEqual(
      [
        { orderedVia: "wolt", count: 1 },
        { orderedVia: "carrefour", count: 1 },
        { orderedVia: "other", count: 1 },
      ],
    );
  });

  it("collapses several rows on the same service into one group", () => {
    const otherMilk = row({
      id: "milk2",
      status: "ordered",
      orderedVia: "wolt",
    });

    expect(groupOrderedByService([MILK, otherMilk])).toEqual([
      { orderedVia: "wolt", count: 2 },
    ]);
  });

  it("returns nothing when no row is ordered", () => {
    expect(groupOrderedByService([LEMONS, EGGS])).toEqual([]);
  });

  it("groups a service-less ordered row under null, listed last", () => {
    const stray = row({ id: "stray", status: "ordered", orderedVia: null });

    expect(groupOrderedByService([MILK, stray])).toEqual([
      { orderedVia: "wolt", count: 1 },
      { orderedVia: null, count: 1 },
    ]);
  });

  it("always orders groups wolt, carrefour, other regardless of row order", () => {
    expect(groupOrderedByService([CANDLES, FLOUR, MILK])).toEqual([
      { orderedVia: "wolt", count: 1 },
      { orderedVia: "carrefour", count: 1 },
      { orderedVia: "other", count: 1 },
    ]);
  });
});

describe("receivableServiceGroups", () => {
  it("passes real services through unchanged", () => {
    const groups = groupOrderedByService([MILK, FLOUR, CANDLES]);

    expect(receivableServiceGroups(groups)).toEqual(groups);
  });

  it("drops the null group — receiveOrder cannot be scoped to it alone", () => {
    // A mix of real services *and* a service-less row: the null bucket must
    // never get a button of its own, or tapping it would receive the wolt
    // and carrefour rows too (`orderedVia: null` means "every service" to
    // `cart.receiveOrder`, not "only the service-less ones").
    const stray = row({ id: "stray", status: "ordered", orderedVia: null });
    const groups = groupOrderedByService([MILK, FLOUR, stray]);

    expect(groups.some((group) => group.orderedVia === null)).toBe(true);
    expect(receivableServiceGroups(groups)).toEqual([
      { orderedVia: "wolt", count: 1 },
      { orderedVia: "carrefour", count: 1 },
    ]);
  });

  it("returns an empty array when only the null group exists", () => {
    const stray = row({ id: "stray", status: "ordered", orderedVia: null });

    expect(receivableServiceGroups(groupOrderedByService([stray]))).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(receivableServiceGroups([])).toEqual([]);
  });
});
