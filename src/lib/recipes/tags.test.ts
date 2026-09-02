import { describe, expect, it } from "vitest";

import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "./tags";

describe("normalizeTags", () => {
  it("keeps the design's own tags untouched", () => {
    expect(normalizeTags(["ужин", "духовка"])).toEqual(["ужин", "духовка"]);
  });

  it("trims, lower-cases and collapses inner whitespace", () => {
    expect(normalizeTags(["  Ужин  ", "Быстрый   Завтрак"])).toEqual([
      "ужин",
      "быстрый завтрак",
    ]);
  });

  it("drops empty and whitespace-only entries", () => {
    expect(normalizeTags(["", "   ", "суп"])).toEqual(["суп"]);
  });

  it("dedupes after normalization, keeping the first occurrence", () => {
    expect(normalizeTags(["Ужин", "ужин ", "УЖИН", "суп"])).toEqual([
      "ужин",
      "суп",
    ]);
  });

  it("does not fold ё into е — a tag is displayed exactly as stored", () => {
    expect(normalizeTags(["Тёплое", "теплое"])).toEqual(["тёплое", "теплое"]);
  });

  it("caps each tag's length and trims what the cut leaves behind", () => {
    const long = `${"а".repeat(MAX_TAG_LENGTH)} хвост`;

    expect(normalizeTags([long])).toEqual(["а".repeat(MAX_TAG_LENGTH)]);
  });

  it("caps how many tags survive", () => {
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `тег${i}`);

    expect(normalizeTags(many)).toHaveLength(MAX_TAGS);
    expect(normalizeTags(many)[MAX_TAGS - 1]).toBe(`тег${MAX_TAGS - 1}`);
  });
});
