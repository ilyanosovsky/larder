import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "@/server/catalog/default-categories";
import {
  fallbackCategoryId,
  resolveCategoryIdForSlug,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";

/** The seven rows `household.create` writes, with stable ids. */
const HOUSEHOLD_CATEGORIES: HouseholdCategory[] = DEFAULT_CATEGORIES.map(
  (category, index) => ({
    id: `cat-${category.slug}`,
    name: category.name,
    sortOrder: index,
  }),
);

describe("fallbackCategoryId", () => {
  it("picks «Бакалея» when the household still has it", () => {
    expect(fallbackCategoryId(HOUSEHOLD_CATEGORIES)).toBe("cat-grocery");
  });

  it("falls back to the first department by walking order", () => {
    const withoutGrocery = HOUSEHOLD_CATEGORIES.filter(
      (category) => category.id !== "cat-grocery",
    );

    expect(fallbackCategoryId(withoutGrocery)).toBe("cat-produce");
  });

  it("reads walking order from sortOrder, not from array order", () => {
    const shuffled = [
      { id: "cat-b", name: "Второй", sortOrder: 5 },
      { id: "cat-a", name: "Первый", sortOrder: 1 },
    ];

    expect(fallbackCategoryId(shuffled)).toBe("cat-a");
  });

  it("is null only when the household has no departments at all", () => {
    expect(fallbackCategoryId([])).toBeNull();
  });
});

describe("resolveCategoryIdForSlug", () => {
  it("maps a reference slug onto the household's own row, by name", () => {
    expect(resolveCategoryIdForSlug("dairy", HOUSEHOLD_CATEGORIES)).toBe(
      "cat-dairy",
    );
    expect(resolveCategoryIdForSlug("household", HOUSEHOLD_CATEGORIES)).toBe(
      "cat-household",
    );
  });

  it("matches through the shared normalization", () => {
    // A household that typed its department name with a stray space or an
    // "е" instead of "ё" is still the same department.
    const renamed: HouseholdCategory[] = [
      { id: "cat-frozen", name: "  ЗАМОРОЗКА  ", sortOrder: 0 },
    ];

    expect(resolveCategoryIdForSlug("frozen", renamed)).toBe("cat-frozen");
  });

  it("falls back when the household renamed that department away", () => {
    // Renaming «Заморозка» to something else is allowed; the reference entry
    // then lands in «Бакалея» rather than nowhere, and stays editable.
    const renamed = HOUSEHOLD_CATEGORIES.map((category) =>
      category.id === "cat-frozen"
        ? { ...category, name: "Морозилка и лёд" }
        : category,
    );

    expect(resolveCategoryIdForSlug("frozen", renamed)).toBe("cat-grocery");
  });

  it("is null for a household with no departments", () => {
    expect(resolveCategoryIdForSlug("produce", [])).toBeNull();
  });
});
