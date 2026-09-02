import { describe, expect, it } from "vitest";

import { collectTags, filterDishes } from "./filter-dishes";

/** DESIGN_BRIEF §5's own library, tags included. */
const LIBRARY = [
  { title: "Лазанья болоньезе", tags: ["ужин", "духовка"] },
  { title: "NYC Cookies", tags: ["выпечка", "духовка"] },
  { title: "Том-ям", tags: ["суп", "острое"] },
  { title: "Шакшука", tags: ["завтрак", "быстро"] },
  { title: "Паста карбонара", tags: ["ужин", "быстро"] },
  { title: "Оладьи", tags: ["завтрак"] },
] as const;

const NO_FILTER = { query: "", tag: null } as const;

function titles(dishes: readonly { title: string }[]): string[] {
  return dishes.map((dish) => dish.title);
}

describe("filterDishes", () => {
  it("returns everything when nothing is filtered", () => {
    expect(titles(filterDishes(LIBRARY, NO_FILTER))).toEqual(titles(LIBRARY));
  });

  it("matches the title, case-insensitively", () => {
    expect(titles(filterDishes(LIBRARY, { query: "лазан", tag: null }))).toEqual(
      ["Лазанья болоньезе"],
    );
    expect(titles(filterDishes(LIBRARY, { query: "NYC", tag: null }))).toEqual([
      "NYC Cookies",
    ]);
  });

  it("matches tags too, so the box and the chips agree", () => {
    expect(
      titles(filterDishes(LIBRARY, { query: "духовк", tag: null })),
    ).toEqual(["Лазанья болоньезе", "NYC Cookies"]);
  });

  it("is ё-insensitive, like the catalog's own comparison", () => {
    const dishes = [{ title: "Тёплый салат", tags: ["ужин"] }];

    expect(
      titles(filterDishes(dishes, { query: "теплый", tag: null })),
    ).toHaveLength(1);
    expect(
      titles(filterDishes([{ title: "Салат", tags: ["тёплое"] }], {
        query: "теплое",
        tag: null,
      })),
    ).toHaveLength(1);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(titles(filterDishes(LIBRARY, { query: "  том  ", tag: null }))).toEqual(
      ["Том-ям"],
    );
  });

  it("filters by an exact tag, not by a tag prefix", () => {
    // «ужин» must not also match a hypothetical «ужин на двоих» chip: the
    // chip row shows whole tags, so tapping one means exactly that tag.
    const dishes = [
      { title: "А", tags: ["ужин"] },
      { title: "Б", tags: ["ужинать позже"] },
    ];

    expect(titles(filterDishes(dishes, { query: "", tag: "ужин" }))).toEqual([
      "А",
    ]);
  });

  it("combines a tag and a query", () => {
    expect(
      titles(filterDishes(LIBRARY, { query: "паста", tag: "ужин" })),
    ).toEqual(["Паста карбонара"]);
    expect(
      titles(filterDishes(LIBRARY, { query: "паста", tag: "завтрак" })),
    ).toEqual([]);
  });

  it("preserves the library's own order", () => {
    expect(titles(filterDishes(LIBRARY, { query: "", tag: "быстро" }))).toEqual([
      "Шакшука",
      "Паста карбонара",
    ]);
  });

  it("returns an empty list rather than everything for a miss", () => {
    expect(filterDishes(LIBRARY, { query: "борщ", tag: null })).toEqual([]);
  });
});

describe("collectTags", () => {
  it("orders by frequency, then alphabetically", () => {
    // ужин 2, духовка 2, быстро 2, завтрак 2, выпечка 1, суп 1, острое 1.
    expect(collectTags(LIBRARY)).toEqual([
      "быстро",
      "духовка",
      "завтрак",
      "ужин",
      "выпечка",
      "острое",
      "суп",
    ]);
  });

  it("lists a tag once however many dishes carry it", () => {
    expect(
      collectTags([
        { title: "А", tags: ["ужин"] },
        { title: "Б", tags: ["ужин"] },
      ]),
    ).toEqual(["ужин"]);
  });

  it("never invents «все» — that is a UI state, not a tag", () => {
    expect(collectTags(LIBRARY)).not.toContain("все");
  });

  it("is empty for a library with no tags", () => {
    expect(collectTags([{ title: "Оладьи", tags: [] }])).toEqual([]);
  });
});
