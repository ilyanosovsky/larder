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

  it("binds through the staple's own name when the query used an alias", () => {
    // The household owns «Помидоры»; the recipe says «томат», which is the
    // built-in entry's alias but not theirs. Step 1 cannot see the connection
    // — it compares the query against their row — and the entry is what
    // bridges the two spellings.
    expect(
      match(
        ["томат"],
        [product("Помидоры")],
        [reference("Помидоры", ["томат"])],
      ).map(shape),
    ).toEqual(["catalog:Помидоры"]);
  });

  it("binds the household's own row rather than minting the staple twice", () => {
    // «Картошка» owned, «Картофель» asked for. The unique index is on
    // `normalized_name`, so a second row would insert cleanly and the catalog
    // would carry one potato twice — with each row naming the other in its
    // aliases. The catalog ships 85 alternate spellings across 72 of its 189
    // entries, so there is no shortage of ways to hit this.
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

  it("leaves an ambiguous name unbound — against the real catalog", () => {
    // «масло» is a prefix of «Масло сливочное», «Масло оливковое» and «Масло
    // подсолнечное», so ranking refuses the tie, and it is the name of none of
    // them, so the exact tier finds nothing either. It stays unbound and a
    // human chooses — asserted against the shipped `REFERENCE_PRODUCTS`, not a
    // fixture, because the whole question is what the real data does.
    expect(
      matchIngredients({
        names: ["масло"],
        products: [],
        categories: CATEGORIES,
      }).map(shape),
    ).toEqual(["none:масло"]);
  });
});

describe("matchIngredients — the shipped reference catalog", () => {
  /** What a first household sees: nothing bought yet, the seven departments. */
  function staple(name: string) {
    const [result] = matchIngredients({
      names: [name],
      products: [],
      categories: CATEGORIES,
    });
    return result?.kind === "reference"
      ? result.ref.name
      : (result?.kind ?? "");
  }

  it("binds the everyday words that the ranker alone cannot", () => {
    // Each of these is a prefix of two or more entries — so `bestCatalogMatch`
    // declines the tie — while being the exact name or alias of one of them.
    // Before the exact tier existed every one cost a billed enrichment call
    // and minted a bare row that then hid the curated staple from
    // autocomplete.
    expect(staple("сыр")).toBe("Сыр твёрдый");
    expect(staple("сахар")).toBe("Сахар белый");
    expect(staple("чай")).toBe("Чай чёрный");
    expect(staple("капуста")).toBe("Капуста белокочанная");
    expect(staple("колбаса")).toBe("Колбаса варёная");
    expect(staple("помидор")).toBe("Помидоры");
    // «томат» is not even the best-ranked: «Томатная паста» and «Томаты в
    // собственном соку» both beat «Помидоры» on prefix. The exact alias wins.
    expect(staple("томат")).toBe("Помидоры");
  });

  it("still answers the unambiguous names through the ranker", () => {
    expect(staple("мука")).toBe("Мука");
    expect(staple("Мука")).toBe("Мука");
  });

  it("says none for a word the catalog does not ship", () => {
    expect(staple("буррата")).toBe("none");
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
