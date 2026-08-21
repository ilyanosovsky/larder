import { describe, expect, it } from "vitest";

import { queuedCartRowIds, type QueuedCartMutation } from "./queued-mutations";

const ROW_A = "0f1a9b0c-1111-4222-8333-444455556666";
const ROW_B = "1a2b3c4d-5555-4666-8777-888899990000";

/** `cart.setStatus`'s input, as the S3 checkbox sends it. */
function setStatus(id: string, isPaused = true): QueuedCartMutation {
  return { variables: { id, status: "bought" }, isPaused };
}

/** `cart.updateItem`'s input — a partial patch, id plus whatever changed. */
function updateItem(id: string, isPaused = true): QueuedCartMutation {
  return { variables: { id, qty: 3, unit: "шт" }, isPaused };
}

/** `cart.remove`'s input — the id and nothing else. */
function remove(id: string, isPaused = true): QueuedCartMutation {
  return { variables: { id }, isPaused };
}

/** `cart.add`'s input — a product, deliberately not a row. */
function add(isPaused = true): QueuedCartMutation {
  return {
    variables: {
      productId: "ffffffff-1111-4222-8333-444455556666",
      qty: 2,
      unit: "шт",
    },
    isPaused,
  };
}

describe("queuedCartRowIds", () => {
  it("marks the row a queued setStatus is about", () => {
    expect(queuedCartRowIds([setStatus(ROW_A)])).toEqual(new Set([ROW_A]));
  });

  it("marks the rows a queued updateItem and remove are about", () => {
    expect(queuedCartRowIds([updateItem(ROW_A), remove(ROW_B)])).toEqual(
      new Set([ROW_A, ROW_B]),
    );
  });

  it("marks no row for a queued add — the line it will create does not exist yet", () => {
    expect(queuedCartRowIds([add()])).toEqual(new Set());
  });

  it("still marks the other rows when an add is queued alongside them", () => {
    expect(queuedCartRowIds([add(), setStatus(ROW_A)])).toEqual(
      new Set([ROW_A]),
    );
  });

  it("ignores a mutation that is in flight rather than paused", () => {
    // On the wire already: the row shows `data-pending` from task 2.3, and
    // 🕐 means "waiting for the connection", not "waiting for the server".
    expect(queuedCartRowIds([setStatus(ROW_A, false)])).toEqual(new Set());
  });

  it("collapses several queued changes to one row into one mark", () => {
    expect(
      queuedCartRowIds([setStatus(ROW_A), updateItem(ROW_A), remove(ROW_A)]),
    ).toEqual(new Set([ROW_A]));
  });

  it("returns an empty set when nothing is queued", () => {
    expect(queuedCartRowIds([])).toEqual(new Set());
  });

  it("tolerates variables that are not the shape it expects", () => {
    // These can come back from IndexedDB, written by an older build.
    const odd: QueuedCartMutation[] = [
      { variables: undefined, isPaused: true },
      { variables: null, isPaused: true },
      { variables: "0f1a9b0c", isPaused: true },
      { variables: { id: 42 }, isPaused: true },
      { variables: { id: "" }, isPaused: true },
      { variables: [ROW_A], isPaused: true },
    ];

    expect(queuedCartRowIds(odd)).toEqual(new Set());
  });
});
