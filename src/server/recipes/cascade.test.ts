import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decideUrlStrategy, extractPageSkeleton, pageTitle } from "./cascade";

function fixture(name: string): string {
  return readFileSync(`src/server/recipes/__fixtures__/${name}`, "utf8");
}

const RAMBLER =
  "https://eda.rambler.ru/recepty/osnovnye-blyuda/kotlety-s-ovsyanymi-hlopyami-192922";
const POVAR = "https://povar.ru/recipes/bliny_na_moloke-473.html";
const RUSSIANFOOD = "https://www.russianfood.com/recipes/recipe.php?rid=179072";

describe("decideUrlStrategy — the three verified sites (VISION §6.4)", () => {
  it("takes eda.rambler.ru for free, from its JSON-LD", () => {
    const strategy = decideUrlStrategy({
      url: RAMBLER,
      html: fixture("rambler-jsonld.html"),
    });

    expect(strategy.kind).toBe("jsonld");
    expect(
      strategy.kind === "jsonld" && strategy.skeleton.ingredients,
    ).toHaveLength(8);
  });

  it("takes povar.ru for free, from its microdata", () => {
    // The page *does* carry an `ld+json` block — an `Organization`. Reading
    // "has JSON-LD" as "has a recipe" would send this to FireCrawl.
    const strategy = decideUrlStrategy({
      url: POVAR,
      html: fixture("povar-microdata.html"),
    });

    expect(strategy.kind).toBe("microdata");
    expect(
      strategy.kind === "microdata" && strategy.skeleton.title,
    ).toBe("Блины на молоке");
  });

  it("sends russianfood.com to FireCrawl — it has nothing structured", () => {
    expect(
      decideUrlStrategy({
        url: RUSSIANFOOD,
        html: fixture("russianfood-plain.html"),
      }),
    ).toEqual({ kind: "firecrawl" });
  });

  it("skips the fetch for a login wall", () => {
    expect(
      decideUrlStrategy({
        url: "https://www.instagram.com/p/abc/",
        html: null,
      }),
    ).toEqual({ kind: "skipFetch" });

    // …even if a fetch somehow produced HTML: an Instagram login page can
    // carry structured data, and none of it is the recipe.
    expect(
      decideUrlStrategy({
        url: "https://www.instagram.com/p/abc/",
        html: fixture("rambler-jsonld.html"),
      }),
    ).toEqual({ kind: "skipFetch" });
  });

  it("falls to FireCrawl when the fetch produced no HTML at all", () => {
    expect(decideUrlStrategy({ url: RAMBLER, html: null })).toEqual({
      kind: "firecrawl",
    });
  });
});

describe("extractPageSkeleton", () => {
  it("prefers JSON-LD over microdata when a page has both", () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"Recipe","name":"Из JSON-LD","recipeIngredient":["Мука 285 г"]}
      </script>
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Из микроданных</h1>
        <li itemprop="recipeIngredient">Соль щепотка</li>
      </div>`;

    const extracted = extractPageSkeleton(html);
    expect(extracted?.kind).toBe("jsonld");
    expect(extracted?.skeleton.title).toBe("Из JSON-LD");
  });

  it("falls through a Recipe node that has no ingredients", () => {
    // A teaser card: a name, an image, and nothing to cook. Taking it would
    // mean skipping FireCrawl for a page whose recipe we never read.
    const html = `
      <script type="application/ld+json">
        {"@type":"Recipe","name":"Рецепт дня","image":"https://x/a.jpg"}
      </script>
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Настоящий рецепт</h1>
        <li itemprop="recipeIngredient">Мука 285 г</li>
      </div>`;

    expect(extractPageSkeleton(html)?.kind).toBe("microdata");
  });

  it("returns null when neither rung finds anything usable", () => {
    expect(extractPageSkeleton(fixture("russianfood-plain.html"))).toBeNull();
  });
});

describe("pageTitle — what a failed import can still prefill", () => {
  it("prefers og:title over the document title", () => {
    expect(
      pageTitle(
        '<html><head><title>Сайт — раздел — рецепт</title><meta property="og:title" content="Блины на молоке" /></head></html>',
      ),
    ).toBe("Блины на молоке");
  });

  it("falls back to <title>", () => {
    expect(pageTitle(fixture("russianfood-plain.html"))).toBe(
      "Рецепт: Говяжий гуляш на тёмном пиве на RussianFood.com",
    );
  });

  it("returns null when there is no title at all", () => {
    expect(pageTitle("<html><body>ничего</body></html>")).toBeNull();
    expect(pageTitle("<html><head><title>   </title></head></html>")).toBeNull();
  });
});
