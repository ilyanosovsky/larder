import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  extractJsonLdNodes,
  findRecipeNode,
  recipeSkeletonFromJsonLd,
} from "./jsonld";

function fixture(name: string): string {
  return readFileSync(`src/server/recipes/__fixtures__/${name}`, "utf8");
}

function skeletonOf(html: string) {
  const node = findRecipeNode(extractJsonLdNodes(html));
  expect(node).not.toBeNull();
  return recipeSkeletonFromJsonLd(node!);
}

/** A page carrying exactly the given JSON-LD blocks and nothing else. */
function page(...blocks: string[]): string {
  return `<!doctype html><html><head>${blocks
    .map((block) => `<script type="application/ld+json">${block}</script>`)
    .join("")}</head><body></body></html>`;
}

describe("eda.rambler.ru — the free first rung", () => {
  const skeleton = skeletonOf(fixture("rambler-jsonld.html"));

  it("reads the recipe past the page's other JSON-LD blocks", () => {
    // The page also ships an `Organization` and a `BreadcrumbList`; picking
    // the first node instead of the first *Recipe* would title the dish
    // «Рамблер/еда».
    expect(skeleton.title).toBe("Котлеты с овсяными хлопьями");
  });

  it("keeps every ingredient line verbatim and in order", () => {
    expect(skeleton.ingredients).toEqual([
      "Смешанный фарш, 400 г",
      "Овсяные хлопья, 50 г",
      "Жирное молоко, 50 мл",
      "Соль, по вкусу",
      "Молотый черный перец, по вкусу",
      "Панировочные сухари, 8 столовых ложек",
      "Растительное масло, 3 столовые ложки",
      "Куриное яйцо, 1 штука",
    ]);
  });

  it("flattens HowToStep objects into ordered step text", () => {
    expect(skeleton.steps).toHaveLength(14);
    expect(skeleton.steps[0]).toBe("Овсянку помолоть в блендере.");
    expect(skeleton.steps.at(-1)).toBe("Котлетки готовы.");
  });

  it("reads the yield and the ISO duration", () => {
    expect(skeleton.yieldText).toBe("8");
    expect(skeleton.totalTimeMin).toBe(20);
  });

  it("takes the first ImageObject's URL out of the image array", () => {
    expect(skeleton.image).toMatch(/^https:\/\/s1\.eda\.ru\/.+\.jpg$/);
  });
});

describe("the shapes JSON-LD actually arrives in", () => {
  it("reads an @graph wrapper, an array @type, sections and an ImageObject", () => {
    const skeleton = skeletonOf(fixture("dirty-graph.html"));

    expect(skeleton.title).toBe("Печенье NYC");
    expect(skeleton.image).toBe("https://example.invalid/cookies.jpg");
    // `recipeYield` as an array: the first usable member wins.
    expect(skeleton.yieldText).toBe("7-8 печений");
    expect(skeleton.totalTimeMin).toBe(75);
    expect(skeleton.ingredients).toHaveLength(3);
    // Both HowToSections flattened, in order — and the section *headings*
    // («Тесто», «Выпечка») are not steps: nobody does them.
    expect(skeleton.steps).toEqual([
      "Взбей масло с сахаром.",
      "Вмешай муку.",
      "Выпекать 9–11 минут при 200 °C.",
    ]);
    expect(skeleton.tags).toEqual(["десерт", "выпечка"]);
  });

  it("does not abort the scan when one block is malformed", () => {
    // The malformed block in that fixture is deliberately the FIRST one.
    expect(extractJsonLdNodes(fixture("dirty-graph.html"))).toHaveLength(2);
  });

  it("reads a top-level array of nodes", () => {
    const html = page(
      JSON.stringify([
        { "@type": "WebPage", name: "страница" },
        {
          "@type": "Recipe",
          name: "Шакшука",
          recipeIngredient: ["Яйца, 4 шт"],
        },
      ]),
    );

    expect(skeletonOf(html).title).toBe("Шакшука");
  });

  it("reads the `schema:` prefix form and a full IRI @type", () => {
    expect(
      skeletonOf(
        page(
          JSON.stringify({
            "@type": "schema:Recipe",
            name: "Борщ",
            recipeIngredient: ["Свёкла, 1 шт"],
          }),
        ),
      ).title,
    ).toBe("Борщ");

    expect(
      skeletonOf(
        page(
          JSON.stringify({
            "@type": "http://schema.org/Recipe",
            name: "Плов",
            recipeIngredient: ["Рис, 300 г"],
          }),
        ),
      ).title,
    ).toBe("Плов");
  });

  it("reads recipeIngredient given as one string rather than a list", () => {
    expect(
      skeletonOf(
        page(
          JSON.stringify({
            "@type": "Recipe",
            name: "Омлет",
            recipeIngredient: "Яйца, 3 шт",
          }),
        ),
      ).ingredients,
    ).toEqual(["Яйца, 3 шт"]);
  });

  it.each([
    ["a plain string", "Смешать.\nЖарить.", ["Смешать.", "Жарить."]],
    ["a list of strings", ["Смешать.", "Жарить."], ["Смешать.", "Жарить."]],
  ])("reads recipeInstructions as %s", (_label, instructions, expected) => {
    expect(
      skeletonOf(
        page(
          JSON.stringify({
            "@type": "Recipe",
            name: "Тест",
            recipeIngredient: ["Соль, щепотка"],
            recipeInstructions: instructions,
          }),
        ),
      ).steps,
    ).toEqual(expected);
  });

  it.each([
    ["a bare string", "https://example.invalid/a.jpg"],
    ["an array", ["https://example.invalid/a.jpg", "https://x/b.jpg"]],
    [
      "an ImageObject",
      { "@type": "ImageObject", url: "https://example.invalid/a.jpg" },
    ],
    [
      "an array of ImageObjects",
      [{ "@type": "ImageObject", url: "https://example.invalid/a.jpg" }],
    ],
  ])("reads image given as %s", (_label, image) => {
    expect(
      skeletonOf(
        page(
          JSON.stringify({
            "@type": "Recipe",
            name: "Тест",
            recipeIngredient: ["Соль"],
            image,
          }),
        ),
      ).image,
    ).toBe("https://example.invalid/a.jpg");
  });

  it("refuses a relative or data: image rather than storing an unusable src", () => {
    for (const image of ["/img/a.jpg", "data:image/png;base64,AAAA"]) {
      expect(
        skeletonOf(
          page(
            JSON.stringify({
              "@type": "Recipe",
              name: "Тест",
              recipeIngredient: ["Соль"],
              image,
            }),
          ),
        ).image,
      ).toBeNull();
    }
  });

  it.each([8, "8", ["8 порций"]])(
    "reads recipeYield given as %o",
    (recipeYield) => {
      expect(
        skeletonOf(
          page(
            JSON.stringify({
              "@type": "Recipe",
              name: "Тест",
              recipeIngredient: ["Соль"],
              recipeYield,
            }),
          ),
        ).yieldText,
      ).toMatch(/^8/);
    },
  );
});

describe("findRecipeNode", () => {
  it("returns null for a page with no recipe on it", () => {
    // russianfood.com: the reason the third rung of the cascade exists.
    expect(
      findRecipeNode(extractJsonLdNodes(fixture("russianfood-plain.html"))),
    ).toBeNull();

    expect(
      findRecipeNode(
        extractJsonLdNodes(page(JSON.stringify({ "@type": "Article" }))),
      ),
    ).toBeNull();
  });

  it("does not confuse a type ending in Recipe with a Recipe", () => {
    expect(
      findRecipeNode([{ "@type": "PartialRecipe", name: "нет" }]),
    ).toBeNull();
  });

  it("ignores a script of another type entirely", () => {
    const html =
      '<script type="application/json">{"@type":"Recipe","name":"нет"}</script>';

    expect(extractJsonLdNodes(html)).toEqual([]);
  });

  it("survives an empty document", () => {
    expect(extractJsonLdNodes("")).toEqual([]);
    expect(findRecipeNode([])).toBeNull();
  });
});
