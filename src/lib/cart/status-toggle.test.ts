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

describe("rolling a failed toggle back per row", () => {
  // The screen rolls a failed `setStatus` back by re-applying the row's
  // previous status through `applyStatusToggle`, rather than restoring a
  // whole-list snapshot taken in `onMutate`. These cover why: two toggles
  // overlap all the time — ticking down a shelf is exactly that — and a
  // snapshot taken before A knows nothing about B.

  it("undoes only the row that failed, leaving a concurrent tick alone", () => {
    const initial = [row("a", "needed"), row("b", "needed")];

    // Both taps land optimistically…
    const withA = applyStatusToggle(initial, "a", "bought");
    const withBoth = applyStatusToggle(withA, "b", "bought");
    // …then A's request fails.
    const rolledBack = applyStatusToggle(withBoth, "a", "needed");

    expect(rolledBack.map((item) => [item.id, item.status])).toEqual([
      ["a", "needed"],
      ["b", "bought"],
    ]);
  });

  it("survives both requests failing, in either order", () => {
    const initial = [row("a", "needed"), row("b", "needed")];
    const withBoth = applyStatusToggle(
      applyStatusToggle(initial, "a", "bought"),
      "b",
      "bought",
    );

    const aThenB = applyStatusToggle(
      applyStatusToggle(withBoth, "a", "needed"),
      "b",
      "needed",
    );
    const bThenA = applyStatusToggle(
      applyStatusToggle(withBoth, "b", "needed"),
      "a",
      "needed",
    );

    for (const result of [aThenB, bThenA]) {
      expect(result.map((item) => item.status)).toEqual(["needed", "needed"]);
    }
  });

  it("does not resurrect a row a refetch removed mid-flight", () => {
    // A whole-list snapshot would put it back; a per-row inverse cannot.
    const afterRefetch = [row("b", "needed")];

    expect(applyStatusToggle(afterRefetch, "a", "needed")).toBe(afterRefetch);
  });
});
