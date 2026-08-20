import { describe, expect, it } from "vitest";

import type { Unit } from "@/lib/units";
import { DEFAULT_CATEGORIES } from "@/server/catalog/default-categories";
import type { ReferenceProduct } from "@/server/catalog/reference-products";
import type { HouseholdCategory } from "@/server/catalog/resolve-category";
import {
  findExactMatch,
  findReferenceProduct,
  searchCatalog,
  SEARCH_RESULT_LIMIT,
  type CatalogProduct,
  type CatalogSearchHit,
} from "@/server/catalog/search";

const CATEGORIES: HouseholdCategory[] = DEFAULT_CATEGORIES.map(
  (category, index) => ({
    id: `cat-${category.slug}`,
    name: category.name,
    sortOrder: index,
  }),
);

let nextId = 0;

function product(
  name: string,
  aliases: readonly string[] = [],
  unit: Unit = "шт",
): CatalogProduct {
  nextId += 1;
  return {
    id: `product-${nextId}`,
    name,
    icon: "🥫",
    categoryId: "cat-grocery",
    defaultUnit: unit,
    aliases,
  };
}

function reference(
  name: string,
  aliases: readonly string[] = [],
): ReferenceProduct {
  return {
    name,
    icon: "📦",
    categorySlug: "grocery",
    unit: "шт",
    aliases,
  };
}

/** Result names in order — what the sheet would actually render. */
function names(hits: readonly CatalogSearchHit[]): string[] {
  return hits.map((hit) =>
    hit.source === "catalog" ? hit.product.name : hit.ref.name,
  );
}

function sources(hits: readonly CatalogSearchHit[]): string[] {
  return hits.map((hit) => hit.source);
}

function search(
  query: string,
  products: readonly CatalogProduct[],
  references: readonly ReferenceProduct[] = [],
): CatalogSearchHit[] {
  return searchCatalog({
    query,
    products,
    categories: CATEGORIES,
    references,
  });
}

describe("searchCatalog — empty query", () => {
  it("returns nothing before anything is typed", () => {
    // The sheet shows no list at all until there is something to suggest
    // from — dumping the whole catalog on someone who has not typed is
    // noise, not help.
    expect(search("", [product("Молоко")], [reference("Мука")])).toEqual([]);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(search("   \t ", [product("Молоко")])).toEqual([]);
  });
});

describe("searchCatalog — ranking tiers", () => {
  const products = [
    product("Сыр"), // exact
    product("Сырники замороженные"), // name prefix
    product("Плавленый сыр"), // word-boundary prefix
    product("Ассырти"), // substring, mid-word
    product("Брынза", ["сыр рассольный"]), // alias
  ];

  it("orders exact > name prefix > word prefix > substring > alias", () => {
    expect(names(search("сыр", products))).toEqual([
      "Сыр",
      "Сырники замороженные",
      "Плавленый сыр",
      "Ассырти",
      "Брынза",
    ]);
  });

  it("puts every name match above every alias match", () => {
    // An alias that matches *exactly* still loses to a name that only
    // contains the query: the product literally called that is the one the
    // shopper meant.
    const hits = search("сыр", [
      product("Брынза", ["сыр"]),
      product("Ассырти"),
    ]);

    expect(names(hits)).toEqual(["Ассырти", "Брынза"]);
  });

  it("ranks alias matches among themselves by the same tiers", () => {
    const hits = search("томат", [
      product("Кетчуп", ["томатная паста"]), // alias name-prefix
      product("Соус", ["паста из томатов"]), // alias word-prefix
      product("Помидоры", ["томат"]), // alias exact
    ]);

    expect(names(hits)).toEqual(["Помидоры", "Кетчуп", "Соус"]);
  });

  it("drops entries that match nothing", () => {
    expect(names(search("буррата", products))).toEqual([]);
  });
});

describe("searchCatalog — normalization", () => {
  it("finds a ё-spelled product from an е-spelled query and back", () => {
    expect(names(search("гречнев", [product("Гречнёвая крупа")]))).toEqual([
      "Гречнёвая крупа",
    ]);
    expect(names(search("тёрка", [product("Терка")]))).toEqual(["Терка"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(names(search("  МОЛОКО ", [product("Молоко")]))).toEqual(["Молоко"]);
  });

  it("collapses repeated spaces inside the query", () => {
    expect(names(search("масло   олив", [product("Масло оливковое")]))).toEqual(
      ["Масло оливковое"],
    );
  });
});

describe("searchCatalog — regex-special input", () => {
  it("matches a query full of regex metacharacters literally", () => {
    // Matching is `indexOf`/`startsWith`, never a regex built from the query:
    // anything else would need escaping, and an unescaped "(" is a
    // SyntaxError in the middle of someone's shopping.
    const products = [product("Сыр (твёрдый)"), product("Сыр мягкий")];

    expect(names(search("сыр (тв", products))).toEqual(["Сыр (твёрдый)"]);
    expect(names(search("(твердый)", products))).toEqual(["Сыр (твёрдый)"]);
  });

  it("does not treat a dot or a star as a wildcard", () => {
    expect(names(search(".*", [product("Молоко"), product("Мука")]))).toEqual(
      [],
    );
  });
});

describe("searchCatalog — reference merge", () => {
  it("offers reference entries next to the household's own products", () => {
    const hits = search(
      "мол",
      [product("Молоко козье")],
      [reference("Молоко"), reference("Мука")],
    );

    // The household's own row leads even though the reference name is
    // shorter: source outranks length (see the tie-breaking block below).
    expect(names(hits)).toEqual(["Молоко козье", "Молоко"]);
    expect(sources(hits)).toEqual(["catalog", "reference"]);
  });

  it("resolves a reference entry onto the household's own department", () => {
    const [hit] = search("мук", [], [reference("Мука")]);

    expect(hit).toEqual({
      source: "reference",
      ref: expect.objectContaining({ name: "Мука" }),
      categoryId: "cat-grocery",
    });
  });

  it("drops a reference entry the household already owns by name", () => {
    const hits = search("молок", [product("Молоко")], [reference("Молоко")]);

    expect(names(hits)).toEqual(["Молоко"]);
    expect(sources(hits)).toEqual(["catalog"]);
  });

  it("drops a reference entry whose name is one of the household's aliases", () => {
    // Someone created «Помидорки» with «помидоры» as an alias. Showing the
    // built-in «Помидоры» beside it is how you end up with two rows for one
    // vegetable — the exact duplicate this design exists to prevent.
    const hits = search(
      "помидор",
      [product("Помидорки", ["помидоры"])],
      [reference("Помидоры", ["томат"])],
    );

    expect(names(hits)).toEqual(["Помидорки"]);
  });

  it("drops a reference entry whose alias is one of the household's names", () => {
    const hits = search(
      "томат",
      [product("Томаты")],
      [reference("Помидоры", ["томаты"])],
    );

    expect(names(hits)).toEqual(["Томаты"]);
  });

  it("compares collisions through the shared normalization", () => {
    const hits = search("сем", [product("Сёмга")], [reference("Семга")]);

    expect(names(hits)).toEqual(["Сёмга"]);
  });

  it("keeps a reference entry that only looks similar", () => {
    const hits = search(
      "молок",
      [product("Молоко козье")],
      [reference("Молоко")],
    );

    expect(sources(hits)).toContain("reference");
  });

  it("skips reference entries when the household has no departments", () => {
    // Nothing could be created from the row, so offering it would only
    // produce an error on tap.
    const hits = searchCatalog({
      query: "мук",
      products: [],
      categories: [],
      references: [reference("Мука")],
    });

    expect(hits).toEqual([]);
  });
});

describe("searchCatalog — tie-breaking", () => {
  it("puts the household's own row above a reference entry of the same rank", () => {
    const hits = search(
      "хлеб",
      [product("Хлебцы")],
      [reference("Хлебушек")], // same tier, and a shorter name would win
    );

    expect(sources(hits)).toEqual(["catalog", "reference"]);
  });

  it("puts the shorter name first within one tier", () => {
    const hits = search("пом", [
      product("Помидоры черри"),
      product("Помидоры"),
    ]);

    expect(names(hits)).toEqual(["Помидоры", "Помидоры черри"]);
  });

  it("orders equal-length names alphabetically, so the list is stable", () => {
    const hits = search("мо", [product("Моцарелла"), product("Мороженое")]);

    expect(names(hits)).toEqual(["Мороженое", "Моцарелла"]);
  });
});

describe("searchCatalog — result limit", () => {
  it("returns at most ten suggestions", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      product(`Молоко ${String(index).padStart(2, "0")}`),
    );

    expect(search("молоко", many)).toHaveLength(SEARCH_RESULT_LIMIT);
  });

  it("keeps the best-ranked ones when it truncates", () => {
    const many = [
      ...Array.from({ length: 20 }, (_, index) =>
        product(`Хлеб ${String(index).padStart(2, "0")}`),
      ),
      product("Хлеб"),
    ];

    expect(names(search("хлеб", many))[0]).toBe("Хлеб");
  });
});

describe("searchCatalog — against the real reference catalog", () => {
  it("suggests the built-in staples DESIGN_BRIEF S4 promises", () => {
    // The «пом…» → «🍅 Помидоры», «🍅 Помидоры черри» example, run against
    // the shipped list rather than a fixture.
    const hits = searchCatalog({
      query: "пом",
      products: [],
      categories: CATEGORIES,
    });

    expect(names(hits).slice(0, 2)).toEqual(["Помидоры", "Помидоры черри"]);
    expect(hits.every((hit) => hit.source === "reference")).toBe(true);
  });

  it("finds a staple through one of its shipped aliases", () => {
    const hits = searchCatalog({
      query: "томат",
      products: [],
      categories: CATEGORIES,
    });

    expect(names(hits)).toContain("Помидоры");
  });
});

describe("findExactMatch", () => {
  const products = [product("Помидоры", ["томат", "томаты"])];

  it("finds a product by its exact normalized name", () => {
    expect(findExactMatch("  ПОМИДОРЫ ", products)?.name).toBe("Помидоры");
  });

  it("finds a product by an exact alias", () => {
    expect(findExactMatch("томаты", products)?.name).toBe("Помидоры");
  });

  it("is null for a partial match", () => {
    expect(findExactMatch("помид", products)).toBeNull();
  });

  it("is null for an empty query", () => {
    expect(findExactMatch("   ", products)).toBeNull();
  });
});

describe("findReferenceProduct", () => {
  it("resolves a reference entry by name, ignoring case and ё", () => {
    expect(findReferenceProduct("гречка")?.name).toBeDefined();
    expect(findReferenceProduct("ПОМИДОРЫ")?.name).toBe("Помидоры");
  });

  it("resolves a reference entry through an alias", () => {
    expect(findReferenceProduct("томат")?.name).toBe("Помидоры");
  });

  it("is null for something nobody shipped", () => {
    expect(findReferenceProduct("буррата")).toBeNull();
  });

  it("is null for an empty query", () => {
    expect(findReferenceProduct("")).toBeNull();
  });
});
