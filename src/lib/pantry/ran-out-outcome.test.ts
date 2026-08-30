import { describe, expect, it } from "vitest";

import { describePantryRanOutOutcome } from "@/lib/pantry/ran-out-outcome";
import type { RanOutOutput } from "@/server/api/routers/pantry";

const ITEM = {
  id: "0f1a9b0c-1111-4222-8333-444455556666",
  productId: "0f1a9b0c-2222-4222-8333-444455556666",
  qty: 1,
  unit: "шт" as const,
  status: "needed" as const,
  note: null,
  orderedVia: null,
  addedById: "user_1",
  buyerId: null,
  createdAt: new Date("2026-08-20T10:00:00.000Z"),
  updatedAt: new Date("2026-08-20T10:00:00.000Z"),
};

describe("describePantryRanOutOutcome", () => {
  it("toasts «в корзине» for a freshly added line", () => {
    const result: RanOutOutput = { outcome: "added", item: ITEM };
    expect(describePantryRanOutOutcome(result)).toEqual({
      toastKey: "toastInCart",
    });
  });

  it("toasts the same «в корзине» for a restored line", () => {
    // Deliberately the same toast as `added` — from the shopper's side both
    // simply mean "it's back on the list now".
    const result: RanOutOutput = {
      outcome: "restored",
      item: { ...ITEM, status: "needed" },
    };
    expect(describePantryRanOutOutcome(result)).toEqual({
      toastKey: "toastInCart",
    });
  });

  it("toasts «уже в корзине» when the line was left untouched", () => {
    const result: RanOutOutput = { outcome: "alreadyInCart", item: ITEM };
    expect(describePantryRanOutOutcome(result)).toEqual({
      toastKey: "toastAlreadyInCart",
    });
  });

  it("is silent for a pantry row someone else already cleared", () => {
    const result: RanOutOutput = { outcome: "gone" };
    expect(describePantryRanOutOutcome(result)).toEqual({ toastKey: null });
  });
});
