import { describe, expect, it } from "vitest";

import { describeCartAddOutcome } from "@/lib/cart/add-outcome";
import type { CartItemOutput } from "@/server/api/routers/cart";

const item: CartItemOutput = {
  id: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  qty: 6,
  unit: "шт",
  status: "needed",
  note: null,
  orderedVia: null,
  addedById: "user-1",
  buyerId: null,
  createdAt: new Date("2026-08-21T10:00:00Z"),
  updatedAt: new Date("2026-08-21T10:00:00Z"),
};

describe("describeCartAddOutcome", () => {
  it("announces a new line", () => {
    expect(describeCartAddOutcome({ outcome: "added", item })).toEqual({
      toastKey: "toastAdded",
      highlightId: item.id,
      needsRestoreConfirm: false,
    });
  });

  it("announces a merge — the no-duplicates promise, made visible", () => {
    expect(
      describeCartAddOutcome({ outcome: "merged", item, previousQty: 4 }),
    ).toEqual({
      toastKey: "toastMerged",
      highlightId: item.id,
      needsRestoreConfirm: false,
    });
  });

  it("explains a unit conflict and points at the row", () => {
    // Nothing was written, so `updatedAt` did not move and the refetch
    // highlight has nothing to notice — this is where `highlightId` earns its
    // keep.
    expect(describeCartAddOutcome({ outcome: "unitMismatch", item })).toEqual({
      toastKey: "toastUnitMismatch",
      highlightId: item.id,
      needsRestoreConfirm: false,
    });
  });

  it("asks before resurrecting a bought line, and says nothing else", () => {
    // A toast competing with the question is how the question gets missed.
    expect(describeCartAddOutcome({ outcome: "boughtExists", item })).toEqual({
      toastKey: null,
      highlightId: item.id,
      needsRestoreConfirm: true,
    });
  });

  it("announces the result of taking that offer", () => {
    expect(describeCartAddOutcome({ outcome: "restored", item })).toEqual({
      toastKey: "toastRestored",
      highlightId: item.id,
      needsRestoreConfirm: false,
    });
  });
});
