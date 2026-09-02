import { describe, expect, it } from "vitest";

import type { Unit } from "@/lib/units";
import { DEFAULT_CATEGORIES } from "@/server/catalog/default-categories";
import type { ReferenceProduct } from "@/server/catalog/reference-products";
import type { HouseholdCategory } from "@/server/catalog/resolve-category";
import type { CatalogProduct } from "@/server/catalog/search";
import {
  isUsableProductName,
  matchIngredients,
  type IngredientMatch,
} from "@/server/recipes/match-ingredients";

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
  return { name, icon: "📦", categorySlug: "grocery", unit: "шт", aliases };
}

function match(
  names: readonly string[],
  products: readonly CatalogProduct[] = [],
  references: readonly ReferenceProduct[] = [],
): IngredientMatch[] {
  return matchIngredients({
    names,
    products,
    categories: CATEGORIES,
    references,
  });
}

/** The shape an assertion cares about, without the whole row. */
function shape(result: IngredientMatch): string {
  switch (result.kind) {
    case "catalog":
      return `catalog:${result.product.name}`;
    case "reference":
      return `reference:${result.ref.name}`;
    case "none":
      return `none:${result.name}`;
  }
}

describe("matchIngredients — the household's own catalog", () => {
  it("binds an exact name", () => {
    expect(match(["Мука"], [product("Мука")]).map(shape)).toEqual([
      "catalog:Мука",
    ]);
  });

  it("binds through an alias", () => {
    expect(
      match(["томаты"], [product("Помидоры", ["томаты"])]).map(shape),
    ).toEqual(["catalog:Помидоры"]);
  });

  it("binds a word-prefix", () => {
    expect(
      match(["сливочное"], [product("Масло сливочное")]).map(shape),
    ).toEqual(["catalog:Масло сливочное"]);
  });

  it("refuses a bare substring", () => {
    // «ливочное» is inside «Масло сливочное» but starts no word in it. A
    // substring bind is invisible on the form and wrong in the cart.
    expect(
      match(["ливочное"], [product("Масло сливочное")]).map(shape),
    ).toEqual(["none:ливочное"]);
  });

  it("does not read one butter as another", () => {
    expect(
      match(["Масло сливочное"], [product("Масло оливковое")]).map(shape),
    ).toEqual(["none:Масло сливочное"]);
  });

  it("binds nothing for an ambiguous «масло»", () => {
    expect(
      match(
        ["масло"],
        [product("Масло сливочное"), product("Масло подсолнечное")],
      ).map(shape),
    ).toEqual(["none:масло"]);
  });

  it("prefers an exact household row over a reference entry of the same name", () => {
    // `findExactMatch` runs first, so a curated row wins even where a
    // reference entry would rank identically.
    expect(
      match(["Мука"], [product("Мука")], [reference("Мука")]).map(shape),
    ).toEqual(["catalog:Мука"]);
  });

  it("binds an exact household name even when another row ties on rank", () => {
    // The ambiguity guard belongs to the ranker; an outright name match is
    // not ambiguous, whatever else happens to score the same.
    expect(
      match(["Масло"], [product("Масло"), product("Масло сливочное")]).map(
        shape,
      ),
    ).toEqual(["catalog:Масло"]);
  });
});

describe("matchIngredients — the reference catalog", () => {
  it("resolves a staple nobody has bought yet", () => {
    const [result] = match(["мука"], [], [reference("Мука")]);

    expect(result?.kind).toBe("reference");
    expect(result?.kind === "reference" ? result.categoryId : null).toBe(
      "cat-grocery",
    );
  });

  it("resolves through a reference alias", () => {
    expect(
      match(["томат"], [], [reference("Помидоры", ["томат"])]).map(shape),
    ).toEqual(["reference:Помидоры"]);
  });

  it("lets the household's own row win a tie against a reference entry", () => {
    expect(
      match(["мук"], [product("Мука")], [reference("Мука")]).map(shape),
    ).toEqual(["catalog:Мука"]);
  });

  it("reaches the reference list when the ranker dropped an owned spelling", () => {
    // The tier that only step 3 can answer, and the one the shipped catalog
    // actually produces: a household owning «Томаты» makes `rankCatalog` drop
    // the built-in «Помидоры» as a spelling it already has, so tier 2 declines
    // — and «Помидоры» must still resolve rather than cost an AI call.
    const owned = product("Томаты");
    expect(
      match(["Помидоры"], [owned], [reference("Помидоры", ["томаты"])]).map(
        shape,
      ),
    ).toEqual(["catalog:Томаты"]);
  });

  it("binds the household's own row rather than minting the staple twice", () => {
    // «Картошка» owned, «Картофель» asked for. The unique index is on
    // `normalized_name`, so a second row would insert cleanly and the catalog
    // would carry one potato twice — with each row naming the other in its
    // aliases. 103 such pairs exist in the shipped reference catalog.
    const owned = product("Картошка");
    expect(
      match(["Картофель"], [owned], [reference("Картофель", ["картошка"])]).map(
        shape,
      ),
    ).toEqual(["catalog:Картошка"]);
  });

  it("still mints a staple the household does not own in any spelling", () => {
    expect(
      match(
        ["Картофель"],
        [product("Мука")],
        [reference("Картофель", ["картошка"])],
      ).map(shape),
    ).toEqual(["reference:Картофель"]);
  });

  it("gives up when no department can hold the reference entry", () => {
    // A household with no departments at all cannot receive a product, so the
    // ranker drops every reference entry and the row stays unbound.
    expect(
      matchIngredients({
        names: ["Помидоры"],
        products: [],
        categories: [],
        references: [reference("Помидоры", ["томаты"])],
      }).map(shape),
    ).toEqual(["none:Помидоры"]);
  });

  it("leaves an ambiguous name unbound rather than taking the first staple", () => {
    // Both entries answer to «масло» through an alias, so the ranker refuses
    // the tie — and nothing downstream may resolve it by array order. This is
    // the case a `findReferenceProduct` fallback would have silently bound.
    expect(
      match(
        ["масло"],
        [],
        [
          reference("Масло сливочное", ["масло"]),
          reference("Масло оливковое", ["масло"]),
        ],
      ).map(shape),
    ).toEqual(["none:масло"]);
  });
});

describe("matchIngredients — names that are not products", () => {
  it("gives up on an empty name", () => {
    expect(match([""], [product("Мука")]).map(shape)).toEqual(["none:"]);
  });

  it("gives up on punctuation a bad parse left behind", () => {
    expect(match(["—"], [product("Мука")]).map(shape)).toEqual(["none:—"]);
    expect(match(["..."], [product("Мука")]).map(shape)).toEqual(["none:..."]);
  });

  it("keeps a name with a digit in it — «Молоко 3.2%» is a real product", () => {
    expect(isUsableProductName("Молоко 3.2%")).toBe(true);
    expect(isUsableProductName("Мука ц/з")).toBe(true);
    expect(isUsableProductName("Соль")).toBe(true);
    expect(isUsableProductName("   ")).toBe(false);
    expect(isUsableProductName("•")).toBe(false);
    expect(isUsableProductName("-")).toBe(false);
  });

  it("accepts a bracketed cross-reference — the rule is letters, not sense", () => {
    // Pinned so the docs cannot drift back into claiming otherwise: the guard
    // is «has a letter or a digit», and this has both. Judging whether a name
    // reads like a product is a different rule, and a stricter one would start
    // refusing real ingredients.
    expect(isUsableProductName("(см. шаг 3)")).toBe(true);
  });
});

describe("matchIngredients — the 1:1 contract", () => {
  it("answers every name, in the order it was asked", () => {
    const results = match(
      ["Мука", "Буррата", "томаты", "—"],
      [product("Мука"), product("Помидоры", ["томаты"])],
      [reference("Сахар")],
    );

    expect(results).toHaveLength(4);
    expect(results.map(shape)).toEqual([
      "catalog:Мука",
      "none:Буррата",
      "catalog:Помидоры",
      "none:—",
    ]);
  });

  it("returns nothing for no names", () => {
    expect(match([])).toEqual([]);
  });
});
