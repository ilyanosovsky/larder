import { describe, expect, it } from "vitest";

import { recipeDraftSchema } from "@/lib/recipes/draft";
import type { ParsedRecipe } from "@/server/ai/parse-recipe";
import { MAX_QTY } from "@/server/cart/merge";
import {
  draftFromParsed,
  type DraftSource,
} from "@/server/recipes/draft-from-parsed";
import type { IngredientMatch } from "@/server/recipes/match-ingredients";

const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";

const PHOTO_SOURCE: DraftSource = {
  sourceType: "photo",
  sourceUrl: null,
  photoUrl: "https://app1.ufs.sh/f/abc123",
  photoKey: "abc123",
};

function ingredient(
  overrides: Partial<ParsedRecipe["ingredients"][number]> = {},
): ParsedRecipe["ingredients"][number] {
  return {
    rawText: "Мука — 285 г",
    name: "Мука",
    qty: 285,
    unit: "г",
    note: null,
    isOptional: false,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedRecipe> = {}): ParsedRecipe {
  return {
    isRecipe: true,
    title: "NYC Cookies",
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    totalTimeMin: 30,
    equipment: ["духовка", "миксер"],
    tags: ["Десерт", "выпечка"],
    ingredients: [ingredient()],
    steps: [{ text: "Смешать сухое", timerSec: null, timerMaxSec: null }],
    ...overrides,
  };
}

/** No catalog binding unless a test asks for one. */
function noMatches(recipe: ParsedRecipe): IngredientMatch[] {
  return recipe.ingredients.map((row) => ({ kind: "none", name: row.name }));
}

function run(recipe: ParsedRecipe, matches?: IngredientMatch[]) {
  return draftFromParsed({
    parsed: recipe,
    matches: matches ?? noMatches(recipe),
    source: PHOTO_SOURCE,
  });
}

function draftOf(recipe: ParsedRecipe, matches?: IngredientMatch[]) {
  const result = run(recipe, matches);
  if (!result.ok) {
    throw new Error(`expected a draft, got ${result.reason}`);
  }
  return result.draft;
}

describe("the happy path", () => {
  it("produces a draft that validates against recipeDraftSchema", () => {
    // The contract the whole task rests on: whatever comes out of here is
    // storable, renderable and re-submittable without a second normalization.
    expect(recipeDraftSchema.safeParse(draftOf(parsed())).success).toBe(true);
  });

  it("carries the source's own photo, key and type", () => {
    const draft = draftOf(parsed());

    expect(draft.photoUrl).toBe("https://app1.ufs.sh/f/abc123");
    expect(draft.photoKey).toBe("abc123");
    expect(draft.sourceType).toBe("photo");
    expect(draft.sourceUrl).toBeNull();
  });

  it("keeps the yield noun verbatim and the range as two integers", () => {
    const draft = draftOf(parsed());

    expect(draft.portionsBase).toBe(8);
    expect(draft.portionsMin).toBe(7);
    expect(draft.yieldUnit).toBe("печений");
  });

  it("normalizes tags and coerces equipment words to slugs", () => {
    const draft = draftOf(
      parsed({ equipment: ["Духовка", "миксер", "космолёт", "духовка"] }),
    );

    expect(draft.tags).toEqual(["десерт", "выпечка"]);
    expect(draft.equipment).toEqual(["oven", "mixer"]);
  });

  it("numbers the rows by array order", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({ name: "Мука" }),
          ingredient({ name: "Сахар" }),
        ],
      }),
    );

    expect(draft.ingredients.map((row) => row.name)).toEqual(["Мука", "Сахар"]);
  });
});

describe("quantities are never invented", () => {
  it("nulls an out-of-range qty instead of clamping it", () => {
    const draft = draftOf(
      parsed({ ingredients: [ingredient({ qty: MAX_QTY + 1 })] }),
    );

    expect(draft.ingredients[0]?.qty).toBeNull();
    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });

  it("nulls a zero qty rather than lifting it to MIN_QTY", () => {
    const draft = draftOf(parsed({ ingredients: [ingredient({ qty: 0 })] }));

    expect(draft.ingredients[0]?.qty).toBeNull();
    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "nulls a non-finite qty (%s)",
    (qty) => {
      const draft = draftOf(parsed({ ingredients: [ingredient({ qty })] }));
      expect(draft.ingredients[0]?.qty).toBeNull();
    },
  );

  it("keeps a fractional quantity exactly as stated", () => {
    const draft = draftOf(
      parsed({
        ingredients: [ingredient({ name: "Соль", qty: 0.75, unit: "ч.л." })],
      }),
    );

    expect(draft.ingredients[0]?.qty).toBe(0.75);
    expect(draft.ingredients[0]?.unit).toBe("ч.л.");
    expect(draft.ingredients[0]?.needsReview).toBe(false);
  });

  it("flags a row whose qty had to be discarded even when it is optional", () => {
    // `deriveNeedsReview` alone would say «опционально, всё в порядке»; but a
    // number we threw away is a hole in the import, not a deliberate choice.
    const draft = draftOf(
      parsed({
        ingredients: [ingredient({ qty: Number.NaN, isOptional: true })],
      }),
    );

    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });
});

describe("units and notes", () => {
  it("appends an unmapped measure to the note instead of dropping it", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({
            rawText: "Чеснок — 2 зубчика",
            name: "Чеснок",
            qty: 2,
            unit: "зубчик",
          }),
        ],
      }),
    );

    expect(draft.ingredients[0]).toMatchObject({
      qty: 2,
      unit: null,
      note: "зубчик",
      // A quantity that states itself in words is not a hole.
      needsReview: false,
    });
  });

  it("keeps the model's own note alongside the leftover", () => {
    const draft = draftOf(
      parsed({
        ingredients: [ingredient({ note: "холодное", unit: "зубчик", qty: 1 })],
      }),
    );

    expect(draft.ingredients[0]?.note).toBe("холодное, зубчик");
  });

  it("does not repeat a note the leftover already says", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({ note: "по вкусу", unit: "По вкусу", qty: null }),
        ],
      }),
    );

    expect(draft.ingredients[0]?.note).toBe("по вкусу");
    // «Соль по вкусу» is a complete instruction, not a parse failure.
    expect(draft.ingredients[0]?.needsReview).toBe(false);
  });

  it("leaves a missing quantity flagged when nothing explains it", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({
            rawText: "Кукурузный крахмал",
            name: "Крахмал",
            qty: null,
            unit: null,
            note: null,
          }),
        ],
      }),
    );

    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });
});

describe("the name sanity check", () => {
  it("falls back to rawText when the name carries a digit", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({ rawText: "Молоко 3,2% — 200 мл", name: "Молоко 3,2%" }),
        ],
      }),
    );

    expect(draft.ingredients[0]?.name).toBe("Молоко 3,2% — 200 мл");
    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });

  it("falls back when the name still carries a unit word", () => {
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({ rawText: "Стакан йогурта", name: "Стакан йогурта" }),
        ],
      }),
    );

    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });

  it("does not trip on a product whose name merely contains a unit's letters", () => {
    // Word-by-word, not substring: «Гречка» must not read as «г».
    const draft = draftOf(
      parsed({
        ingredients: [
          ingredient({ rawText: "Гречка — 200 г", name: "Гречка" }),
        ],
      }),
    );

    expect(draft.ingredients[0]?.name).toBe("Гречка");
    expect(draft.ingredients[0]?.needsReview).toBe(false);
  });

  it("falls back when the name is a whole sentence", () => {
    const long =
      "Шоколад крупными кусками, желательно горький, не менее семидесяти";
    const draft = draftOf(
      parsed({
        ingredients: [ingredient({ rawText: "Шоколад — 150 г", name: long })],
      }),
    );

    expect(draft.ingredients[0]?.name).toBe("Шоколад — 150 г");
    expect(draft.ingredients[0]?.needsReview).toBe(true);
  });

  it("drops a row with neither a name nor a source line", () => {
    const recipe = parsed({
      ingredients: [ingredient(), ingredient({ rawText: "  ", name: "  " })],
    });

    expect(draftOf(recipe).ingredients).toHaveLength(1);
  });
});

describe("catalog binding", () => {
  it("binds only what the household already owns", () => {
    const recipe = parsed({
      ingredients: [
        ingredient({ name: "Мука" }),
        ingredient({ name: "Сахар" }),
      ],
    });

    const draft = draftOf(recipe, [
      {
        kind: "catalog",
        product: {
          id: PRODUCT_ID,
          name: "Мука",
          icon: "🌾",
          categoryId: "cat-1",
          defaultUnit: "кг",
          aliases: [],
        },
      },
      // A reference hit still has to *create* a product, and products are
      // created on save — so it reaches the form as «новый».
      {
        kind: "reference",
        ref: {
          name: "Сахар",
          icon: "🍬",
          categorySlug: "grocery",
          unit: "кг",
          aliases: [],
        },
        categoryId: "cat-2",
      },
    ]);

    expect(draft.ingredients[0]?.productId).toBe(PRODUCT_ID);
    expect(draft.ingredients[1]?.productId).toBeNull();
  });

  it("pairs matches to rows by index", () => {
    const recipe = parsed({
      ingredients: [
        ingredient({ name: "Мука" }),
        ingredient({ name: "Сахар" }),
      ],
    });

    const draft = draftOf(recipe, [
      { kind: "none", name: "Мука" },
      {
        kind: "catalog",
        product: {
          id: PRODUCT_ID,
          name: "Сахар",
          icon: "🍬",
          categoryId: "cat-2",
          defaultUnit: "кг",
          aliases: [],
        },
      },
    ]);

    expect(draft.ingredients[0]?.productId).toBeNull();
    expect(draft.ingredients[1]?.productId).toBe(PRODUCT_ID);
  });
});

describe("steps and timers", () => {
  it("keeps a stated range as two integers", () => {
    const draft = draftOf(
      parsed({
        steps: [{ text: "Выпекать", timerSec: 540, timerMaxSec: 660 }],
      }),
    );

    expect(draft.steps[0]).toEqual({
      text: "Выпекать",
      timerSec: 540,
      timerMaxSec: 660,
    });
  });

  it("drops an upper bound with no lower bound under it", () => {
    const draft = draftOf(
      parsed({
        steps: [{ text: "Выпекать", timerSec: null, timerMaxSec: 660 }],
      }),
    );

    expect(draft.steps[0]?.timerMaxSec).toBeNull();
  });

  it("drops an upper bound below the lower one", () => {
    const draft = draftOf(
      parsed({
        steps: [{ text: "Выпекать", timerSec: 660, timerMaxSec: 540 }],
      }),
    );

    expect(draft.steps[0]).toEqual({
      text: "Выпекать",
      timerSec: 660,
      timerMaxSec: null,
    });
  });

  it("drops an out-of-range timer rather than clamping it to a day", () => {
    const draft = draftOf(
      parsed({
        steps: [
          { text: "Ферментировать", timerSec: 900_000, timerMaxSec: null },
        ],
      }),
    );

    expect(draft.steps[0]?.timerSec).toBeNull();
  });

  it("drops steps with no text", () => {
    const draft = draftOf(
      parsed({
        steps: [
          { text: "Смешать", timerSec: null, timerMaxSec: null },
          { text: "   ", timerSec: null, timerMaxSec: null },
        ],
      }),
    );

    expect(draft.steps).toHaveLength(1);
  });
});

describe("portions and time", () => {
  it("falls back to the schema default when the source states no yield", () => {
    const draft = draftOf(parsed({ portionsBase: null, portionsMin: null }));
    expect(draft.portionsBase).toBe(2);
    expect(draft.portionsMin).toBeNull();
  });

  it("drops a portionsMin that is not below portionsBase", () => {
    expect(
      draftOf(parsed({ portionsBase: 8, portionsMin: 8 })).portionsMin,
    ).toBeNull();
    expect(
      draftOf(parsed({ portionsBase: 8, portionsMin: 9 })).portionsMin,
    ).toBeNull();
  });

  it("falls back on an absurd yield rather than storing it", () => {
    expect(draftOf(parsed({ portionsBase: 5000 })).portionsBase).toBe(2);
  });

  it("nulls an out-of-range total time", () => {
    expect(draftOf(parsed({ totalTimeMin: 0 })).totalTimeMin).toBeNull();
    expect(draftOf(parsed({ totalTimeMin: 99_999 })).totalTimeMin).toBeNull();
  });

  it("rounds a fractional total time to whole minutes", () => {
    expect(draftOf(parsed({ totalTimeMin: 29.6 })).totalTimeMin).toBe(30);
  });
});

describe("not a recipe", () => {
  it("reports isRecipe:false as an outcome, not as a draft", () => {
    expect(run(parsed({ isRecipe: false }))).toEqual({
      ok: false,
      reason: "notARecipe",
    });
  });

  it("reports a confident answer with nothing in it", () => {
    // The structural half of the same question: a vision model handed a photo
    // of a cat describes it fluently and returns no ingredients and no steps.
    expect(run(parsed({ ingredients: [], steps: [] }))).toEqual({
      ok: false,
      reason: "notARecipe",
    });
  });

  it("still parses an ingredient card with no steps, and says so", () => {
    const result = run(parsed({ steps: [] }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings).toEqual(["noSteps"]);
  });

  it("still parses a bake sheet with no ingredients, and says so", () => {
    const result = run(parsed({ ingredients: [] }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings).toEqual(["noIngredients"]);
  });
});

describe("the title", () => {
  it("falls back to the first ingredient rather than to an invented string", () => {
    // A Russian placeholder authored here would be UI copy stored in
    // `dishes.title`, outside next-intl — and it would look correct.
    const draft = draftOf(
      parsed({ title: "  ", ingredients: [ingredient({ name: "Мука" })] }),
    );

    expect(draft.title).toBe("Мука");
  });

  it("falls back to the first step when there are no ingredients either", () => {
    const draft = draftOf(
      parsed({
        title: "",
        ingredients: [],
        steps: [
          {
            text: "Разогреть духовку до 205 °C",
            timerSec: null,
            timerMaxSec: null,
          },
        ],
      }),
    );

    expect(draft.title).toBe("Разогреть духовку до 205 °C");
  });

  it("caps a title the schema would reject", () => {
    const draft = draftOf(parsed({ title: "я".repeat(400) }));

    expect(draft.title.length).toBe(120);
    expect(recipeDraftSchema.safeParse(draft).success).toBe(true);
  });
});

describe("caps", () => {
  it("keeps at most sixty ingredients and sixty steps", () => {
    const draft = draftOf(
      parsed({
        ingredients: Array.from({ length: 80 }, (_, index) =>
          ingredient({ name: `Продукт ${index}`, rawText: `Строка ${index}` }),
        ),
        steps: Array.from({ length: 80 }, (_, index) => ({
          text: `Шаг ${index}`,
          timerSec: null,
          timerMaxSec: null,
        })),
      }),
      Array.from({ length: 80 }, (_, index) => ({
        kind: "none" as const,
        name: `Продукт ${index}`,
      })),
    );

    expect(draft.ingredients).toHaveLength(60);
    expect(draft.steps).toHaveLength(60);
    expect(recipeDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("caps a note the schema would reject", () => {
    const draft = draftOf(
      parsed({ ingredients: [ingredient({ note: "о".repeat(400) })] }),
    );

    expect(draft.ingredients[0]?.note?.length).toBe(100);
    expect(recipeDraftSchema.safeParse(draft).success).toBe(true);
  });
});
