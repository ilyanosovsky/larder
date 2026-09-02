import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/server/catalog/normalize";

import { normalizeDishTitle } from "./normalize";

describe("normalizeDishTitle", () => {
  it("lower-cases, folds ё→е and collapses whitespace", () => {
    expect(normalizeDishTitle("  Тёплый   Салат ")).toBe("теплый салат");
  });

  it("makes the design's own titles comparable across spellings", () => {
    expect(normalizeDishTitle("NYC Cookies")).toBe(
      normalizeDishTitle("nyc cookies"),
    );
    expect(normalizeDishTitle("Оладьи")).toBe(normalizeDishTitle("оладьи"));
  });

  it("is the catalog's canon, not a second copy of it", () => {
    // The assertion that matters: if `normalizeProductName` ever gains a step,
    // dish titles gain it too instead of quietly drifting.
    expect(normalizeDishTitle).toBe(normalizeProductName);
  });
});
