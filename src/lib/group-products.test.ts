import { describe, expect, it } from "vitest";

import { groupProductsByCategory } from "@/lib/group-products";

function item(name: string, categoryId: string, categoryName: string) {
  return {
    id: name,
    name,
    categoryId,
    categoryName,
    categoryIcon: "🥬",
  };
}

describe("groupProductsByCategory", () => {
  it("cuts an ordered list into one section per department", () => {
    const sections = groupProductsByCategory([
      item("Помидоры", "produce", "Овощи и фрукты"),
      item("Огурцы", "produce", "Овощи и фрукты"),
      item("Молоко", "dairy", "Молочное и яйца"),
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      categoryId: "produce",
      name: "Овощи и фрукты",
    });
    expect(sections[0]?.items.map((product) => product.name)).toEqual([
      "Помидоры",
      "Огурцы",
    ]);
    expect(sections[1]?.items.map((product) => product.name)).toEqual([
      "Молоко",
    ]);
  });

  it("keeps the order the query returned", () => {
    // The database decides walking order (`sortOrder`, then name); grouping
    // must not re-derive it, or the two eventually disagree.
    const sections = groupProductsByCategory([
      item("Молоко", "dairy", "Молочное и яйца"),
      item("Помидоры", "produce", "Овощи и фрукты"),
    ]);

    expect(sections.map((section) => section.categoryId)).toEqual([
      "dairy",
      "produce",
    ]);
  });

  it("is empty for an empty catalog", () => {
    expect(groupProductsByCategory([])).toEqual([]);
  });

  it("does not merge a department the list revisited", () => {
    // An out-of-order list renders as what it is, rather than being quietly
    // repaired into something that hides the ordering bug.
    const sections = groupProductsByCategory([
      item("Помидоры", "produce", "Овощи и фрукты"),
      item("Молоко", "dairy", "Молочное и яйца"),
      item("Огурцы", "produce", "Овощи и фрукты"),
    ]);

    expect(sections.map((section) => section.categoryId)).toEqual([
      "produce",
      "dairy",
      "produce",
    ]);
  });
});
