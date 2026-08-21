import { describe, expect, it } from "vitest";

import { sortBoughtLast } from "@/lib/cart/sort-rows";
import type { CartItemStatus } from "@/server/cart/merge";

function row(id: string, status: CartItemStatus) {
  return { id, status };
}

describe("sortBoughtLast", () => {
  it("sinks bought lines below the rest", () => {
    const sorted = sortBoughtLast([
      row("помидоры", "needed"),
      row("яйца", "bought"),
      row("огурцы", "needed"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "помидоры",
      "огурцы",
      "яйца",
    ]);
  });

  it("keeps `ordered` in the live half", () => {
    // A line on its way from Wolt is still something to receive, so it stays
    // with «нужно» rather than joining what has already been bought.
    const sorted = sortBoughtLast([
      row("молоко", "bought"),
      row("мука", "ordered"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["мука", "молоко"]);
  });

  it("preserves the server's order inside each half", () => {
    // The query already sorted by department and name; ticking one box must
    // not make the untouched rows shuffle among themselves.
    const sorted = sortBoughtLast([
      row("а", "bought"),
      row("б", "needed"),
      row("в", "bought"),
      row("г", "needed"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["б", "г", "а", "в"]);
  });

  it("leaves a list with nothing bought exactly as it was", () => {
    const items = [row("а", "needed"), row("б", "ordered")];

    expect(sortBoughtLast(items).map((item) => item.id)).toEqual(["а", "б"]);
  });

  it("is empty for an empty section", () => {
    expect(sortBoughtLast([])).toEqual([]);
  });

  it("does not mutate the list it was handed", () => {
    const items = [row("а", "bought"), row("б", "needed")];

    sortBoughtLast(items);

    expect(items.map((item) => item.id)).toEqual(["а", "б"]);
  });
});
