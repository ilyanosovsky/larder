import { describe, expect, it } from "vitest";

import type { DishDetailOutput } from "@/server/api/routers/dish";

import {
  DISH_SOURCE_TYPES,
  draftFromDetail,
  emptyDraft,
  normalizeDraftForSave,
  recipeDraftSchema,
  type RecipeDraft,
} from "./draft";

const DISH_ID = "3f1a6d0e-0000-4000-8000-000000000901";
const RECIPE_ID = "3f1a6d0e-0000-4000-8000-000000000902";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";

function ingredient(
  overrides: Partial<RecipeDraft["ingredients"][number]> = {},
): RecipeDraft["ingredients"][number] {
  return {
    rawText: "Мука — 285 г",
    name: "Мука",
    qty: 285,
    unit: "г",
    note: null,
    isOptional: false,
    needsReview: false,
    productId: null,
    ...overrides,
  };
}

function draft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    ...emptyDraft(),
    title: "NYC Cookies",
    portionsBase: 8,
    ingredients: [ingredient()],
    ...overrides,
  };
}

function detail(): DishDetailOutput {
  return {
    id: DISH_ID,
    title: "NYC Cookies",
    photoUrl: "https://utfs.io/f/cookies.jpg",
    photoKey: "cookies.jpg",
    tags: ["выпечка", "духовка"],
    sourceType: "photo",
    sourceUrl: null,
    version: 3,
    archivedAt: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    recipe: {
      id: RECIPE_ID,
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "печений",
      totalTimeMin: 30,
      equipment: ["oven", "не_слаг"],
      adaptedAt: null,
      adaptedNote: null,
      hasOriginalDraft: true,
    },
    ingredients: [
      {
        id: "3f1a6d0e-0000-4000-8000-000000000911",
        productId: PRODUCT_ID,
        productName: "Мука",
        productIcon: "🌾",
        categoryId: "3f1a6d0e-0000-4000-8000-000000000102",
        rawText: "Мука — 285 г",
        name: "Мука",
        qty: 285,
        unit: "г",
        note: null,
        isOptional: false,
        needsReview: false,
        sortOrder: 0,
        inPantry: true,
      },
      {
        id: "3f1a6d0e-0000-4000-8000-000000000912",
        productId: null,
        productName: null,
        productIcon: null,
        categoryId: null,
        rawText: "Кукурузный крахмал",
        name: "Кукурузный крахмал",
        qty: null,
        unit: null,
        note: null,
        isOptional: false,
        needsReview: true,
        sortOrder: 1,
        inPantry: false,
      },
    ],
    steps: [
      {
        id: "3f1a6d0e-0000-4000-8000-000000000921",
        stepOrder: 0,
        text: "Смешать сухие ингредиенты.",
        timerSec: null,
        timerMaxSec: null,
      },
      {
        id: "3f1a6d0e-0000-4000-8000-000000000922",
        stepOrder: 1,
        text: "Духовка 205 °C, таймер 9–11 мин.",
        timerSec: 540,
        timerMaxSec: 660,
      },
    ],
  };
}

describe("DISH_SOURCE_TYPES", () => {
  it("is the four sources S8 offers, photo first", () => {
    expect([...DISH_SOURCE_TYPES]).toEqual(["photo", "url", "text", "manual"]);
  });
});

describe("recipeDraftSchema", () => {
  it("refuses the empty «✍️ Вручную» draft on its title, and nothing else", () => {
    // The blank form is a legal starting *state*, not a legal save: the only
    // thing standing between it and a valid draft is a name for the dish.
    const parsed = recipeDraftSchema.safeParse(emptyDraft());

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["title"]]);
    expect(
      recipeDraftSchema.safeParse({ ...emptyDraft(), title: "Оладьи" }).success,
    ).toBe(true);
  });

  it("accepts a draft with no ingredients — min(1) is a save-time rule", () => {
    // A parse that found steps but no ingredient list must still reach the
    // review form so a human can type them.
    expect(
      recipeDraftSchema.safeParse(draft({ ingredients: [] })).success,
    ).toBe(true);
  });

  it("accepts an https photo url", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ photoUrl: "https://utfs.io/f/cookies.jpg" }),
      ).success,
    ).toBe(true);
  });

  it("rejects a url whose scheme the browser would execute", () => {
    // zod 4's `z.url()` accepts anything `new URL()` parses, this one does not.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/x.jpg",
    ]) {
      expect(recipeDraftSchema.safeParse(draft({ photoUrl: url })).success).toBe(
        false,
      );
      expect(
        recipeDraftSchema.safeParse(draft({ sourceUrl: url })).success,
      ).toBe(false);
    }
  });

  it("rejects a timer range with no lower bound under it", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ steps: [{ text: "Печь", timerSec: null, timerMaxSec: 660 }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an upper timer bound below the lower one", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ steps: [{ text: "Печь", timerSec: 660, timerMaxSec: 540 }] }),
      ).success,
    ).toBe(false);
  });

  it("accepts a real «9–11 мин» step", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ steps: [{ text: "Печь", timerSec: 540, timerMaxSec: 660 }] }),
      ).success,
    ).toBe(true);
  });

  it("rejects a portionsMin that is not below portionsBase", () => {
    expect(
      recipeDraftSchema.safeParse(draft({ portionsBase: 8, portionsMin: 8 }))
        .success,
    ).toBe(false);
    expect(
      recipeDraftSchema.safeParse(draft({ portionsBase: 8, portionsMin: 9 }))
        .success,
    ).toBe(false);
  });

  it("accepts a real «7–8 печений» yield", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ portionsBase: 8, portionsMin: 7, yieldUnit: "печений" }),
      ).success,
    ).toBe(true);
  });

  it("rejects a quantity the qty column cannot hold", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ ingredients: [ingredient({ qty: 0 })] }),
      ).success,
    ).toBe(false);
    expect(
      recipeDraftSchema.safeParse(
        draft({ ingredients: [ingredient({ qty: 10_001 })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a unit outside RECIPE_UNITS", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ ingredients: [ingredient({ unit: "мешок" as never })] }),
      ).success,
    ).toBe(false);
  });

  it("accepts a recipe-only unit the cart does not know", () => {
    expect(
      recipeDraftSchema.safeParse(
        draft({ ingredients: [ingredient({ qty: 0.75, unit: "ч.л." })] }),
      ).success,
    ).toBe(true);
  });
});

describe("emptyDraft", () => {
  it("starts manual, at two portions, with nothing in it", () => {
    expect(emptyDraft()).toEqual({
      title: "",
      photoUrl: null,
      photoKey: null,
      tags: [],
      sourceType: "manual",
      sourceUrl: null,
      portionsBase: 2,
      portionsMin: null,
      yieldUnit: null,
      totalTimeMin: null,
      equipment: [],
      ingredients: [],
      steps: [],
    });
  });

  it("returns a fresh object every call", () => {
    const first = emptyDraft();
    first.ingredients.push(ingredient());

    expect(emptyDraft().ingredients).toEqual([]);
  });
});

describe("draftFromDetail", () => {
  it("round-trips a saved dish into a draft the schema accepts", () => {
    expect(recipeDraftSchema.safeParse(draftFromDetail(detail())).success).toBe(
      true,
    );
  });

  it("keeps the recipe and drops the storage facts around it", () => {
    const result = draftFromDetail(detail());

    expect(result.title).toBe("NYC Cookies");
    expect(result.portionsBase).toBe(8);
    expect(result.portionsMin).toBe(7);
    expect(result.yieldUnit).toBe("печений");
    expect(result.sourceType).toBe("photo");
    expect(result.ingredients).toHaveLength(2);
    expect(result.ingredients[0]).toEqual({
      rawText: "Мука — 285 г",
      name: "Мука",
      qty: 285,
      unit: "г",
      note: null,
      isOptional: false,
      needsReview: false,
      productId: PRODUCT_ID,
    });
    expect(result.steps[1]).toEqual({
      text: "Духовка 205 °C, таймер 9–11 мин.",
      timerSec: 540,
      timerMaxSec: 660,
    });
  });

  it("drops an equipment slug the app no longer knows", () => {
    // `recipes.equipment` is a text array; a retired slug must not fail the
    // whole edit.
    expect(draftFromDetail(detail()).equipment).toEqual(["oven"]);
  });

  it("copies the tag array rather than aliasing the server's", () => {
    const source = detail();
    const result = draftFromDetail(source);
    result.tags.push("новый");

    expect(source.tags).toEqual(["выпечка", "духовка"]);
  });
});

describe("normalizeDraftForSave", () => {
  it("keeps the order the arrays arrived in — it is the stored order", () => {
    const result = normalizeDraftForSave(
      draft({
        ingredients: [
          ingredient({ name: "Мука" }),
          ingredient({ name: "Соль" }),
        ],
      }),
    );

    expect(result.ingredients.map((row) => row.name)).toEqual([
      "Мука",
      "Соль",
    ]);
  });

  it("drops rows the user emptied", () => {
    const result = normalizeDraftForSave(
      draft({
        ingredients: [
          ingredient({ name: "   " }),
          ingredient({ name: "Соль" }),
        ],
        steps: [
          { text: "  ", timerSec: null, timerMaxSec: null },
          { text: "Смешать", timerSec: null, timerMaxSec: null },
        ],
      }),
    );

    expect(result.ingredients.map((row) => row.name)).toEqual(["Соль"]);
    expect(result.steps.map((step) => step.text)).toEqual(["Смешать"]);
  });

  it("recomputes needsReview instead of copying what arrived", () => {
    const result = normalizeDraftForSave(
      draft({
        ingredients: [
          // Claims to be fine, but has no quantity: the chip goes back on.
          ingredient({ name: "Крахмал", qty: null, unit: null, needsReview: false }),
          // Claims to need review, but states 285 г: the chip comes off.
          ingredient({ needsReview: true }),
          // No quantity, but «по вкусу» is a complete instruction.
          ingredient({
            name: "Соль",
            qty: null,
            unit: null,
            note: "по вкусу",
            needsReview: true,
          }),
        ],
      }),
    );

    expect(result.ingredients.map((row) => row.needsReview)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("normalizes tags", () => {
    expect(
      normalizeDraftForSave(draft({ tags: ["  Ужин ", "ужин", "Духовка"] }))
        .tags,
    ).toEqual(["ужин", "духовка"]);
  });

  it("turns blank notes and a blank yield noun into null", () => {
    const result = normalizeDraftForSave(
      draft({
        yieldUnit: "  ",
        ingredients: [ingredient({ note: "   " })],
      }),
    );

    expect(result.yieldUnit).toBeNull();
    expect(result.ingredients[0]?.note).toBeNull();
  });

  it("drops a timer range that has no lower bound under it", () => {
    const result = normalizeDraftForSave(
      draft({
        steps: [
          { text: "Печь", timerSec: null, timerMaxSec: 660 },
          { text: "Печь", timerSec: 660, timerMaxSec: 540 },
          { text: "Печь", timerSec: 540, timerMaxSec: 660 },
        ],
      }),
    );

    expect(result.steps.map((step) => step.timerMaxSec)).toEqual([
      null,
      null,
      660,
    ]);
  });

  it("drops a portionsMin that is not below the base", () => {
    expect(
      normalizeDraftForSave(draft({ portionsBase: 8, portionsMin: 8 }))
        .portionsMin,
    ).toBeNull();
    expect(
      normalizeDraftForSave(draft({ portionsBase: 8, portionsMin: 7 }))
        .portionsMin,
    ).toBe(7);
  });

  it("produces something the schema still accepts", () => {
    const messy = draft({
      title: "  NYC Cookies  ",
      portionsBase: 8,
      portionsMin: 8,
      tags: ["Выпечка", "выпечка", ""],
      ingredients: [ingredient(), ingredient({ name: "" })],
      steps: [{ text: "Печь", timerSec: null, timerMaxSec: 660 }],
    });

    const result = normalizeDraftForSave(messy);

    expect(recipeDraftSchema.safeParse(result).success).toBe(true);
    expect(result.title).toBe("NYC Cookies");
  });

  it("is idempotent — normalizing twice changes nothing further", () => {
    const once = normalizeDraftForSave(draftFromDetail(detail()));

    expect(normalizeDraftForSave(once)).toEqual(once);
  });
});
