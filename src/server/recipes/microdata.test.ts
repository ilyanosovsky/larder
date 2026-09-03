import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { recipeSkeletonFromMicrodata } from "./microdata";

function fixture(name: string): string {
  return readFileSync(`src/server/recipes/__fixtures__/${name}`, "utf8");
}

describe("povar.ru — the second rung of the cascade", () => {
  const skeleton = recipeSkeletonFromMicrodata(fixture("povar-microdata.html"));

  it("finds the Recipe scope", () => {
    expect(skeleton).not.toBeNull();
  });

  it("titles the dish, not its author", () => {
    // The page nests a `Person` with its own `itemprop="name"` inside the
    // recipe. Reading `[itemprop="name"]` off the whole subtree would name
    // the dish «Deemmaq».
    expect(skeleton?.title).toBe("Блины на молоке");
  });

  it("reads every repeated recipeIngredient, in order, with its quantity", () => {
    // Each `<li>` holds the name and the amount in separate spans; the value
    // is the collapsed text of the whole row or it is nothing useful.
    expect(skeleton?.ingredients).toEqual([
      "Молоко 600 мл",
      "Яйца 3 штуки",
      "Растительное масло 3 ст. ложки",
      "Мука 300 грамм",
      "Сахар 3 ст. ложки",
      "Соль 1 щепотка",
    ]);
  });

  it("reads the nested HowToStep items as steps", () => {
    expect(skeleton?.steps).toHaveLength(13);
    expect(skeleton?.steps[0]).toContain("подготовьте необходимые ингредиенты");
    expect(skeleton?.steps.at(-1)).toBe("Приятного аппетита!");
  });

  it("takes the duration off a <meta content>, not its text", () => {
    // `<meta itemprop="totalTime" content="PT30M">` renders nothing at all;
    // reading `textContent` here returns an empty string.
    expect(skeleton?.totalTimeMin).toBe(30);
  });

  it("reads the yield and the main photo", () => {
    expect(skeleton?.yieldText).toBe("5");
    // The recipe's own image, not step 1's photo — thirteen `HowToStep`s each
    // carry an `itemprop="image"` of their own.
    expect(skeleton?.image).toBe(
      "https://img.povar.ru/main/50/d0/17/3e/blini_na_moloke-857102.jpg",
    );
  });

  it("reads the category words as tags", () => {
    expect(skeleton?.tags).toContain("Блины");
    expect(skeleton?.tags).toContain("Молоко");
  });
});

describe("recipeSkeletonFromMicrodata — the rules", () => {
  it("returns null when there is no Recipe scope", () => {
    expect(
      recipeSkeletonFromMicrodata(fixture("russianfood-plain.html")),
    ).toBeNull();
    expect(
      recipeSkeletonFromMicrodata("<html><body>ничего</body></html>"),
    ).toBeNull();
  });

  it("accepts either scheme and a trailing slash on the itemtype", () => {
    for (const itemtype of [
      "http://schema.org/Recipe",
      "https://schema.org/Recipe",
      "https://schema.org/Recipe/",
    ]) {
      const html = `<div itemscope itemtype="${itemtype}"><h1 itemprop="name">Суп</h1><li itemprop="recipeIngredient">Вода 1 л</li></div>`;
      expect(recipeSkeletonFromMicrodata(html)?.title).toBe("Суп");
    }
  });

  it("ignores an itemprop belonging to a nested scope of another kind", () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Борщ</h1>
        <span itemprop="author" itemscope itemtype="https://schema.org/Person">
          <span itemprop="name">Кира</span>
        </span>
        <li itemprop="recipeIngredient">Свёкла 1 шт</li>
      </div>`;

    const skeleton = recipeSkeletonFromMicrodata(html);
    expect(skeleton?.title).toBe("Борщ");
    expect(skeleton?.ingredients).toEqual(["Свёкла 1 шт"]);
  });

  it("reads a HowToStep's own text property when it has one", () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Тест</h1>
        <li itemprop="recipeIngredient">Соль щепотка</li>
        <div itemprop="recipeInstructions">
          <div itemscope itemtype="https://schema.org/HowToStep">
            <img itemprop="image" src="https://x/1.jpg" />
            <span itemprop="text">Посолить.</span>
          </div>
        </div>
      </div>`;

    expect(recipeSkeletonFromMicrodata(html)?.steps).toEqual(["Посолить."]);
  });

  it("splits a prose recipeInstructions block on its own newlines", () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Тест</h1>
        <li itemprop="recipeIngredient">Соль щепотка</li>
        <div itemprop="recipeInstructions">Смешать.
Жарить пять минут.</div>
      </div>`;

    expect(recipeSkeletonFromMicrodata(html)?.steps).toEqual([
      "Смешать.",
      "Жарить пять минут.",
    ]);
  });

  it("reads a space-separated itemprop list", () => {
    // The spec allows `itemprop="name headline"`; splitting on whitespace is
    // the difference between finding a title and not.
    const html = `<div itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name headline">Уха</h1><li itemprop="recipeIngredient">Рыба 1 кг</li></div>`;

    expect(recipeSkeletonFromMicrodata(html)?.title).toBe("Уха");
  });

  it("prefers an http(s) image and skips a data: one", () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Тест</h1>
        <img itemprop="image" src="data:image/gif;base64,AAA" />
        <img itemprop="image" src="https://example.invalid/real.jpg" />
        <li itemprop="recipeIngredient">Соль щепотка</li>
      </div>`;

    expect(recipeSkeletonFromMicrodata(html)?.image).toBe(
      "https://example.invalid/real.jpg",
    );
  });
});
