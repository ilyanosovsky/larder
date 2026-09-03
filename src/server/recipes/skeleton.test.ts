import { describe, expect, it } from "vitest";

import {
  EMPTY_SKELETON,
  isUsableSkeleton,
  skeletonToHint,
  skeletonToParsedRecipe,
  type RecipeSkeleton,
} from "./skeleton";

const COOKIES: RecipeSkeleton = {
  title: "Печенье NYC",
  image: "https://example.invalid/cookies.jpg",
  yieldText: "7–8 печений",
  totalTimeMin: 75,
  ingredients: ["Мука — 285 г", "Масло сливочное холодное — 227 г"],
  steps: ["Взбей масло с сахаром.", "Выпекать 9–11 минут."],
  tags: ["десерт"],
};

describe("isUsableSkeleton", () => {
  it("needs at least one ingredient", () => {
    expect(isUsableSkeleton(COOKIES)).toBe(true);
    expect(isUsableSkeleton(EMPTY_SKELETON)).toBe(false);
    expect(
      isUsableSkeleton({ ...EMPTY_SKELETON, title: "Есть название" }),
    ).toBe(false);
  });

  it("accepts a recipe with no steps at all", () => {
    // DESIGN_BRIEF's own NYC Cookies card is mostly a shopping list, and the
    // review screen exists precisely so the missing half can be typed in.
    expect(isUsableSkeleton({ ...COOKIES, steps: [] })).toBe(true);
  });
});

describe("skeletonToHint", () => {
  const hint = skeletonToHint(COOKIES);

  it("carries every line the page gave us", () => {
    expect(hint).toContain("Название: Печенье NYC");
    expect(hint).toContain("Выход: 7–8 печений");
    expect(hint).toContain("Время: 75 мин");
    expect(hint).toContain("- Мука — 285 г");
    expect(hint).toContain("1. Взбей масло с сахаром.");
  });

  it("carries no instructions of its own", () => {
    // The rules live in the prompt. Duplicating them into the data would be
    // two places to fix one parsing bug.
    expect(hint).not.toMatch(/не выдумывай|правил/i);
  });

  it("omits absent fields rather than writing «null»", () => {
    const bare = skeletonToHint({
      ...EMPTY_SKELETON,
      ingredients: ["Соль по вкусу"],
    });

    expect(bare).not.toContain("Название");
    expect(bare).not.toContain("null");
    expect(bare).toContain("- Соль по вкусу");
  });

  it("caps a pathological page instead of paying for it", () => {
    const huge = skeletonToHint({
      ...EMPTY_SKELETON,
      ingredients: new Array<string>(5_000).fill("Мука — 285 г"),
    });

    expect(huge.length).toBeLessThanOrEqual(12_000);
  });
});

describe("skeletonToParsedRecipe — the fallback when the AI could not run", () => {
  const parsed = skeletonToParsedRecipe(COOKIES);

  it("keeps every line as its own ingredient, unquantified", () => {
    // The import still succeeds: these become amber «уточнить» rows the
    // person can fix, which beats an error screen for a page we had read.
    expect(parsed.ingredients).toEqual([
      {
        rawText: "Мука — 285 г",
        name: "Мука — 285 г",
        qty: null,
        unit: null,
        note: null,
        isOptional: false,
      },
      {
        rawText: "Масло сливочное холодное — 227 г",
        name: "Масло сливочное холодное — 227 г",
        qty: null,
        unit: null,
        note: null,
        isOptional: false,
      },
    ]);
  });

  it("invents no unit and no quantity out of the line", () => {
    for (const row of parsed.ingredients) {
      expect(row.qty).toBeNull();
      expect(row.unit).toBeNull();
    }
  });

  it("reads the yield through the shared portions parser", () => {
    // «7–8» means the quantities are stated for 8 (decision A.1).
    expect(parsed.portionsBase).toBe(8);
    expect(parsed.portionsMin).toBe(7);
  });

  it("keeps the steps, with no timers guessed out of their text", () => {
    expect(parsed.steps).toEqual([
      { text: "Взбей масло с сахаром.", timerSec: null, timerMaxSec: null },
      { text: "Выпекать 9–11 минут.", timerSec: null, timerMaxSec: null },
    ]);
  });

  it("is a recipe — the model's escape hatch is about photos, and it never ran", () => {
    expect(parsed.isRecipe).toBe(true);
    expect(parsed.yieldUnit).toBeNull();
    expect(parsed.equipment).toEqual([]);
  });
});
