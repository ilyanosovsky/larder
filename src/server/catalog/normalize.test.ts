import { describe, expect, it } from "vitest";

import { normalizeProductName, splitWords } from "@/server/catalog/normalize";

describe("normalizeProductName", () => {
  it("trims and lower-cases", () => {
    expect(normalizeProductName("  Молоко ")).toBe("молоко");
  });

  it("folds ё to е, in both cases", () => {
    // Half of Russia types "гречнев" without the diaeresis; both spellings
    // have to reach the same product.
    expect(normalizeProductName("Гречнёвая крупа")).toBe("гречневая крупа");
    expect(normalizeProductName("ЁЛКА")).toBe("елка");
  });

  it("collapses runs of whitespace to a single space", () => {
    expect(normalizeProductName("Масло   оливковое")).toBe("масло оливковое");
    expect(normalizeProductName("Масло\toливковое".replace("o", "о"))).toBe(
      "масло оливковое",
    );
  });

  it("leaves punctuation alone — it carries meaning", () => {
    expect(normalizeProductName("Сыр (твёрдый)")).toBe("сыр (твердый)");
    expect(normalizeProductName("Мясо-гриль")).toBe("мясо-гриль");
  });

  it("is idempotent", () => {
    const once = normalizeProductName("  Помидоры   Черри ");
    expect(normalizeProductName(once)).toBe(once);
  });

  it("maps an all-whitespace string to the empty string", () => {
    expect(normalizeProductName("   \n\t ")).toBe("");
  });
});

describe("splitWords", () => {
  it("splits on spaces and hyphens", () => {
    expect(splitWords("масло оливковое")).toEqual(["масло", "оливковое"]);
    expect(splitWords("мясо-гриль")).toEqual(["мясо", "гриль"]);
  });

  it("drops empty segments", () => {
    expect(splitWords("")).toEqual([]);
    expect(splitWords("-хлеб-")).toEqual(["хлеб"]);
  });
});
