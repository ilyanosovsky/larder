import { describe, expect, it } from "vitest";

import { applyStatusToggle, toggledCartStatus } from "@/lib/cart/status-toggle";
import type { CartItemStatus } from "@/server/cart/merge";

function row(id: string, status: CartItemStatus, updatedAt = new Date(0)) {
  return { id, status, updatedAt, buyerId: null as string | null };
}

describe("toggledCartStatus", () => {
  it("buys a needed line", () => {
    expect(toggledCartStatus("needed")).toBe("bought");
  });

  it("buys an ordered line too", () => {
    // The box is unticked either way, so the tap means the same thing: it is
    // in the house now. Nothing in S3 sets `ordered` back (task 2.5).
    expect(toggledCartStatus("ordered")).toBe("bought");
  });

  it("puts a bought line back into «нужно»", () => {
    expect(toggledCartStatus("bought")).toBe("needed");
  });
});

describe("applyStatusToggle", () => {
  it("replaces the status of the row it names", () => {
    const list = [row("a", "needed"), row("b", "needed")];

    const next = applyStatusToggle(list, "b", "bought");

    expect(next.map((item) => item.status)).toEqual(["needed", "bought"]);
  });

  it("keeps the row where it was", () => {
    // The re-sort belongs to rendering (`sortBoughtLast`), not to the cache:
    // moving the row here would make the list jump twice, once optimistically
    // and once when the refetch lands.
    const list = [row("a", "needed"), row("b", "needed"), row("c", "needed")];

    const next = applyStatusToggle(list, "b", "bought");

    expect(next.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves `updatedAt` and `buyerId` to the server", () => {
    const list = [row("a", "needed", new Date("2026-08-21T10:00:00Z"))];

    const [next] = applyStatusToggle(list, "a", "bought");

    expect(next?.updatedAt).toEqual(new Date("2026-08-21T10:00:00Z"));
    expect(next?.buyerId).toBeNull();
  });

  it("does not mutate the cached list", () => {
    const list = [row("a", "needed")];

    applyStatusToggle(list, "a", "bought");

    expect(list[0]?.status).toBe("needed");
  });

  it("returns the same list when the row is gone", () => {
    // A refetch can remove the row between the tap and `onMutate`; rewriting
    // the cache with an identical copy would be a re-render for nothing.
    const list = [row("a", "needed")];

    expect(applyStatusToggle(list, "missing", "bought")).toBe(list);
  });
});
