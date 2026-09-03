import { describe, expect, it } from "vitest";

import {
  emptyDraft,
  MAX_NOTE,
  MAX_STEPS,
  recipeDraftSchema,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import type { RecipeAdaptation } from "@/server/ai/adapt-recipe";
import {
  applyAdaptation,
  describeAdaptation,
  isEmptyDiff,
  matchDroppedEquipment,
  rescaleDraft,
} from "@/server/recipes/adapt";

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

/** DESIGN_BRIEF §5's own sample recipe, as the seed stores it. */
function nycCookies(): RecipeDraft {
  return {
    ...emptyDraft(),
    title: "NYC Cookies",
    sourceType: "photo",
    tags: ["выпечка", "десерт"],
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    totalTimeMin: 45,
    equipment: ["oven", "mixer"],
    ingredients: [
      ingredient(),
      ingredient({
        rawText: "Масло сливочное холодное, 227 г",
        name: "Масло сливочное",
        qty: 227,
        note: "холодное",
      }),
      ingredient({
        rawText: "Соль — по вкусу",
        name: "Соль",
        qty: null,
        unit: null,
        note: "по вкусу",
      }),
      ingredient({
        rawText: "Кукурузный крахмал",
        name: "Кукурузный крахмал",
        qty: null,
        unit: null,
        needsReview: true,
      }),
    ],
    steps: [
      { text: "Взбить масло с сахаром миксером 3 минуты", timerSec: 180, timerMaxSec: null },
      { text: "Добавить муку и крахмал", timerSec: null, timerMaxSec: null },
      { text: "Выпекать при 205 °C 9–11 минут", timerSec: 540, timerMaxSec: 660 },
    ],
  };
}

function proposal(overrides: Partial<RecipeAdaptation> = {}): RecipeAdaptation {
  return {
    summary: "переделано под венчик вместо миксера",
    ingredients: [],
    steps: [],
    removedStepIndexes: [],
    addedSteps: [],
    droppedEquipment: [],
    ...overrides,
  };
}

const NO_OPTIONS = { targetPortions: null, dropEquipment: [] } as const;

function applied(
  draft: RecipeDraft,
  edits: Partial<RecipeAdaptation>,
  options: Parameters<typeof applyAdaptation>[2] = NO_OPTIONS,
) {
  const result = applyAdaptation(draft, proposal(edits), options);
  if (!result.ok) {
    throw new Error(`expected a draft, got: ${result.error}`);
  }
  return result;
}

describe("rescaleDraft", () => {
  it("halves every stated quantity and re-bases the yield", () => {
    const result = rescaleDraft(nycCookies(), 4);

    expect(result.portionsBase).toBe(4);
    expect(result.ingredients.map((row) => row.qty)).toEqual([
      142.5,
      113.5,
      null,
      null,
    ]);
  });

  it("drops portionsMin and yieldUnit — neither describes the new batch", () => {
    const result = rescaleDraft(nycCookies(), 4);

    // «7–8» was the source's range for its own batch, and «печений» is a
    // genitive plural that was grammatical for 8 and is not for 4.
    expect(result.portionsMin).toBeNull();
    expect(result.yieldUnit).toBeNull();
  });

  it("leaves the source line alone — the recipe really did say 285 г", () => {
    expect(rescaleDraft(nycCookies(), 4).ingredients[0]?.rawText).toBe(
      "Мука — 285 г",
    );
  });

  it("is the identity at the recipe's own base, keeping the range and the noun", () => {
    const draft = nycCookies();
    expect(rescaleDraft(draft, 8)).toBe(draft);
  });

  it("turns a quantity that scales below the storage floor into «уточнить»", () => {
    const draft: RecipeDraft = {
      ...emptyDraft(),
      title: "Соус",
      portionsBase: 100,
      ingredients: [ingredient({ name: "Ваниль", qty: 0.02, unit: "г" })],
    };

    const row = rescaleDraft(draft, 1).ingredients[0];

    // 0.0002 rounds to 0 at `numeric(10, 3)`; a confident «0 г» would claim
    // the recipe asks for none of something.
    expect(row?.qty).toBeNull();
    expect(row?.needsReview).toBe(true);
  });

  it("keeps an optional row unflagged when its quantity disappears", () => {
    const draft: RecipeDraft = {
      ...emptyDraft(),
      title: "Печенье",
      portionsBase: 100,
      ingredients: [
        ingredient({ name: "Biscoff", qty: 0.02, unit: "г", isOptional: true }),
      ],
    };

    expect(rescaleDraft(draft, 1).ingredients[0]?.needsReview).toBe(false);
  });
});

describe("applyAdaptation — the index contract", () => {
  it("drops an ingredient index that no longer exists, never clamps it", () => {
    const draft = nycCookies();
    const result = applied(draft, {
      ingredients: [
        { index: 9, qty: 1, unit: "кг", note: null, rawText: null },
      ],
    });

    // The regression this module exists for: clamping 9 onto row 3 would put
    // a kilogram of flour onto the cornstarch.
    expect(result.draft.ingredients).toEqual(draft.ingredients);
    expect(isEmptyDiff(result.diff)).toBe(true);
  });

  it("drops a negative and a fractional index too", () => {
    const draft = nycCookies();
    const result = applied(draft, {
      ingredients: [
        { index: -1, qty: 1, unit: "кг", note: null, rawText: null },
        { index: 1.5, qty: 2, unit: "кг", note: null, rawText: null },
      ],
    });

    expect(result.draft.ingredients).toEqual(draft.ingredients);
  });

  it("applies the first edit for a row and ignores a repeated one", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 200, unit: "г", note: null, rawText: null },
        { index: 0, qty: 999, unit: "г", note: null, rawText: null },
      ],
    });

    expect(result.draft.ingredients[0]?.qty).toBe(200);
  });

  it("never touches a name, an isOptional flag or a catalog binding", () => {
    const draft = nycCookies();
    draft.ingredients[0] = ingredient({ productId: PRODUCT_ID });

    const result = applied(draft, {
      ingredients: [
        { index: 0, qty: 200, unit: "г", note: "просеять", rawText: null },
      ],
    });

    const row = result.draft.ingredients[0];
    expect(row?.name).toBe("Мука");
    expect(row?.productId).toBe(PRODUCT_ID);
    expect(row?.isOptional).toBe(false);
  });

  it("keeps the source line when the proposal offers none, and replaces it when it does", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 142.5, unit: "г", note: null, rawText: null },
        {
          index: 1,
          qty: 113,
          unit: "г",
          note: "холодное",
          rawText: "Масло сливочное холодное, 113 г",
        },
      ],
    });

    expect(result.draft.ingredients[0]?.rawText).toBe("Мука — 285 г");
    expect(result.draft.ingredients[1]?.rawText).toBe(
      "Масло сливочное холодное, 113 г",
    );
  });

  it("keeps the model's own note alongside the unit it could not map", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 2, unit: "зубчика", note: "крупно", rawText: null },
      ],
    });

    expect(result.draft.ingredients[0]?.note).toBe("крупно, зубчика");
  });

  it("reserves room for the leftover, so a long note cannot eat it", () => {
    // The comment above the merge presents this as an invariant; without the
    // reservation a 100-character note truncates the one word this path
    // promises never to drop.
    const result = applied(nycCookies(), {
      ingredients: [
        {
          index: 0,
          qty: 2,
          unit: "зубчика",
          note: "я".repeat(MAX_NOTE),
          rawText: null,
        },
      ],
    });

    const note = result.draft.ingredients[0]?.note ?? "";
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE);
    expect(note.endsWith("зубчика")).toBe(true);
  });

  it("does not repeat a leftover the note already says", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 2, unit: "зубчик", note: "зубчик", rawText: null },
      ],
    });

    expect(result.draft.ingredients[0]?.note).toBe("зубчик");
  });

  it("routes a unit it cannot map into the note instead of guessing one", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 2, unit: "зубчика", note: null, rawText: null },
      ],
    });

    const row = result.draft.ingredients[0];
    expect(row?.unit).toBeNull();
    expect(row?.note).toBe("зубчика");
    // A quantity that states itself in words is not a hole.
    expect(row?.needsReview).toBe(false);
  });

  it("degrades an out-of-range quantity to «уточнить» rather than clamping it", () => {
    const result = applied(nycCookies(), {
      ingredients: [
        { index: 0, qty: 10_000_000, unit: "г", note: null, rawText: null },
      ],
    });

    expect(result.draft.ingredients[0]?.qty).toBeNull();
    expect(result.draft.ingredients[0]?.needsReview).toBe(true);
  });
});

describe("applyAdaptation — steps", () => {
  it("replaces a step in place and keeps the order", () => {
    const result = applied(nycCookies(), {
      steps: [
        {
          index: 0,
          text: "Взбить масло с сахаром венчиком вручную 6 минут",
          timerSec: 360,
          timerMaxSec: null,
        },
      ],
    });

    expect(result.draft.steps.map((step) => step.text)).toEqual([
      "Взбить масло с сахаром венчиком вручную 6 минут",
      "Добавить муку и крахмал",
      "Выпекать при 205 °C 9–11 минут",
    ]);
    expect(result.diff.changedSteps).toEqual([0]);
    expect(result.diff.addedSteps).toEqual([]);
    expect(result.diff.removedSteps).toEqual([]);
  });

  it("removes a step and reports it by its original index", () => {
    const result = applied(nycCookies(), { removedStepIndexes: [1] });

    expect(result.draft.steps).toHaveLength(2);
    expect(result.diff.removedSteps).toEqual([1]);
  });

  it("inserts an addition after the step it names, and -1 before everything", () => {
    const result = applied(nycCookies(), {
      addedSteps: [
        { afterIndex: -1, text: "Достать масло заранее", timerSec: null, timerMaxSec: null },
        { afterIndex: 0, text: "Дать тесту отдохнуть", timerSec: 600, timerMaxSec: null },
      ],
    });

    expect(result.draft.steps.map((step) => step.text)).toEqual([
      "Достать масло заранее",
      "Взбить масло с сахаром миксером 3 минуты",
      "Дать тесту отдохнуть",
      "Добавить муку и крахмал",
      "Выпекать при 205 °C 9–11 минут",
    ]);
    expect(result.diff.addedSteps).toEqual([0, 2]);
    expect(result.diff.changedSteps).toEqual([]);
  });

  it("keeps two additions anchored at the same step in the order they were listed", () => {
    const result = applied(nycCookies(), {
      addedSteps: [
        { afterIndex: 0, text: "Первый", timerSec: null, timerMaxSec: null },
        { afterIndex: 0, text: "Второй", timerSec: null, timerMaxSec: null },
      ],
    });

    expect(result.draft.steps.map((step) => step.text).slice(0, 3)).toEqual([
      "Взбить масло с сахаром миксером 3 минуты",
      "Первый",
      "Второй",
    ]);
  });

  it("lets a removal and an addition at the same index read as a replacement", () => {
    // «Замени этот шаг на два» — the addition must survive its anchor's
    // removal, or the proposal silently becomes a deletion.
    const result = applied(nycCookies(), {
      removedStepIndexes: [0],
      addedSteps: [
        { afterIndex: 0, text: "Размягчить масло", timerSec: null, timerMaxSec: null },
        { afterIndex: 0, text: "Взбить венчиком вручную", timerSec: 360, timerMaxSec: null },
      ],
    });

    expect(result.draft.steps.map((step) => step.text)).toEqual([
      "Размягчить масло",
      "Взбить венчиком вручную",
      "Добавить муку и крахмал",
      "Выпекать при 205 °C 9–11 минут",
    ]);
    expect(result.diff.removedSteps).toEqual([0]);
    expect(result.diff.addedSteps).toEqual([0, 1]);
  });

  it("drops an addition anchored past the end, never appending it blindly", () => {
    const result = applied(nycCookies(), {
      addedSteps: [
        { afterIndex: 7, text: "Ниоткуда", timerSec: null, timerMaxSec: null },
      ],
    });

    expect(result.draft.steps).toHaveLength(3);
    expect(isEmptyDiff(result.diff)).toBe(true);
  });

  it("drops a step whose replacement text is blank", () => {
    const draft = nycCookies();
    const result = applied(draft, {
      steps: [{ index: 1, text: "   ", timerSec: null, timerMaxSec: null }],
    });

    expect(result.draft.steps).toEqual(draft.steps);
  });

  it("drops a timerMaxSec with no timerSec under it, and one below it", () => {
    const result = applied(nycCookies(), {
      steps: [
        { index: 0, text: "Отдохнуть", timerSec: null, timerMaxSec: 600 },
        { index: 1, text: "Смешать", timerSec: 600, timerMaxSec: 300 },
      ],
    });

    expect(result.draft.steps[0]?.timerMaxSec).toBeNull();
    expect(result.draft.steps[1]?.timerMaxSec).toBeNull();
    expect(result.draft.steps[1]?.timerSec).toBe(600);
  });

  it("drops an out-of-range timer instead of clamping it", () => {
    const result = applied(nycCookies(), {
      steps: [
        { index: 0, text: "Ферментировать", timerSec: 999_999, timerMaxSec: null },
      ],
    });

    expect(result.draft.steps[0]?.timerSec).toBeNull();
  });

  it("stops adding steps at the schema's own ceiling rather than failing", () => {
    const result = applied(nycCookies(), {
      addedSteps: Array.from({ length: MAX_STEPS + 10 }, (_, index) => ({
        afterIndex: 0,
        text: `Шаг ${index}`,
        timerSec: null,
        timerMaxSec: null,
      })),
    });

    expect(result.draft.steps).toHaveLength(MAX_STEPS);
    expect(recipeDraftSchema.safeParse(result.draft).success).toBe(true);
  });
});

describe("applyAdaptation — equipment", () => {
  it("drops an appliance the proposal says it actually worked around", () => {
    const result = applied(
      nycCookies(),
      {
        steps: [
          {
            index: 0,
            text: "Взбить венчиком вручную",
            timerSec: null,
            timerMaxSec: null,
          },
        ],
        droppedEquipment: ["миксер"],
      },
      { targetPortions: null, dropEquipment: ["mixer"] },
    );

    // Otherwise S7's banner keeps reporting «Не хватает: Миксер» forever
    // after the fix has been applied.
    expect(result.draft.equipment).toEqual(["oven"]);
    expect(result.diff.droppedEquipment).toEqual(["mixer"]);
  });

  it("keeps the appliance when the proposal reworked nothing", () => {
    // The regression: prompt rule 14 invites an all-empty proposal, and an
    // unconditional drop turned that into «Больше не нужно: Миксер» over
    // steps that still say «взбить миксером» — silencing the banner for a
    // requirement that never went away.
    const result = applied(
      nycCookies(),
      {},
      { targetPortions: null, dropEquipment: ["mixer"] },
    );

    expect(result.draft.equipment).toEqual(["oven", "mixer"]);
    expect(isEmptyDiff(result.diff)).toBe(true);
  });

  it("drops only the appliance it names, not every missing one", () => {
    const draft: RecipeDraft = {
      ...nycCookies(),
      equipment: ["oven", "mixer", "airfryer"],
    };

    const result = applied(
      draft,
      {
        steps: [
          {
            index: 0,
            text: "Взбить венчиком вручную",
            timerSec: null,
            timerMaxSec: null,
          },
        ],
        droppedEquipment: ["миксер"],
      },
      { targetPortions: null, dropEquipment: ["mixer", "airfryer"] },
    );

    expect(result.draft.equipment).toEqual(["oven", "airfryer"]);
  });

  it("ignores a slug the household was not missing in the first place", () => {
    // A proposal cannot decide to remove a requirement nobody asked about.
    const result = applied(
      nycCookies(),
      { droppedEquipment: ["духовка", "миксер"] },
      { targetPortions: null, dropEquipment: ["mixer"] },
    );

    expect(result.draft.equipment).toEqual(["oven"]);
  });

  it("ignores a word outside the preset vocabulary", () => {
    const result = applied(
      nycCookies(),
      { droppedEquipment: ["сувид", "штуковина"] },
      { targetPortions: null, dropEquipment: ["mixer"] },
    );

    expect(result.draft.equipment).toEqual(["oven", "mixer"]);
  });

  it("never adds an appliance of its own", () => {
    const result = applied(
      nycCookies(),
      {},
      { targetPortions: null, dropEquipment: [] },
    );

    expect(result.draft.equipment).toEqual(["oven", "mixer"]);
  });

  it("counts an equipment removal as a change, so the sheet cannot say «nothing»", () => {
    const result = applied(
      nycCookies(),
      { droppedEquipment: ["миксер"] },
      { targetPortions: null, dropEquipment: ["mixer"] },
    );

    expect(isEmptyDiff(result.diff)).toBe(false);
    expect(result.diff.droppedEquipment).toEqual(["mixer"]);
  });
});

describe("applyAdaptation — NYC Cookies «без миксера», rescaled 8 → 4", () => {
  const result = applied(
    nycCookies(),
    {
      summary: "взбиваем венчиком вручную, пересчитано на 4 печенья",
      ingredients: [
        {
          index: 1,
          qty: 113,
          unit: "г",
          note: "мягкое, комнатной температуры",
          rawText: "Масло сливочное мягкое, 113 г",
        },
      ],
      steps: [
        {
          index: 0,
          text: "Взбить мягкое масло с сахаром венчиком вручную 6–8 минут",
          timerSec: 360,
          timerMaxSec: 480,
        },
      ],
      removedStepIndexes: [],
      addedSteps: [],
      droppedEquipment: ["миксер"],
    },
    { targetPortions: 4, dropEquipment: ["mixer"] },
  );

  it("scales the untouched rows arithmetically and takes the model's override on the one it edited", () => {
    expect(result.draft.ingredients.map((row) => row.qty)).toEqual([
      142.5, // 285 / 2, ours
      113, // the model's own rounding of 113.5, on the row it restated
      null,
      null,
    ]);
  });

  it("reports every quantity the rescale moved, not only the model's own edit", () => {
    // The diff is against the recipe as it stood, so «285 г → 142,5 г» is a
    // change the person approving it can see — even though no proposal row
    // mentioned it.
    expect(result.diff.changedIngredients).toEqual([0, 1]);
    expect(result.diff.changedSteps).toEqual([0]);
  });

  it("comes out as a valid draft with the mixer gone and the yield re-based", () => {
    expect(recipeDraftSchema.safeParse(result.draft).success).toBe(true);
    expect(result.draft.equipment).toEqual(["oven"]);
    expect(result.draft.portionsBase).toBe(4);
    expect(result.draft.portionsMin).toBeNull();
  });

  it("leaves «Соль по вкусу» unflagged and «Кукурузный крахмал» flagged", () => {
    expect(result.draft.ingredients[2]?.needsReview).toBe(false);
    expect(result.draft.ingredients[3]?.needsReview).toBe(true);
  });
});

describe("describeAdaptation", () => {
  it("reports nothing for a proposal that changed nothing", () => {
    const draft = nycCookies();
    const diff = describeAdaptation(draft, draft, [0, 1, 2]);

    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("counts a note-only change as a change", () => {
    const before = nycCookies();
    const after = {
      ...before,
      ingredients: before.ingredients.map((row, index) =>
        index === 0 ? { ...row, note: "просеять" } : row,
      ),
    };

    expect(describeAdaptation(before, after, [0, 1, 2])).toMatchObject({
      changedIngredients: [0],
    });
  });

  it("reads an origin of null as an addition and a missing origin as a removal", () => {
    const before = nycCookies();
    const after = {
      ...before,
      steps: [before.steps[0]!, { text: "Новый", timerSec: null, timerMaxSec: null }],
    };

    expect(describeAdaptation(before, after, [0, null])).toEqual({
      changedIngredients: [],
      changedSteps: [],
      addedSteps: [1],
      removedSteps: [1, 2],
      droppedEquipment: [],
      portionsChanged: false,
      portionsRangeDropped: false,
      yieldUnitDropped: false,
    });
  });
});

describe("matchDroppedEquipment (round 2, R4)", () => {
  it("accepts the exact word the prompt handed the model", () => {
    expect(matchDroppedEquipment(["миксер"], ["mixer"])).toEqual(["mixer"]);
    expect(matchDroppedEquipment(["Миксер."], ["mixer"])).toEqual(["mixer"]);
  });

  it("accepts an inflected or qualified answer — Russian declines", () => {
    // The failure this exists for: «убрали миксером» is unmistakably about
    // the mixer, and refusing it left the recipe declaring an appliance it no
    // longer uses, with S7's banner nagging forever.
    for (const said of [
      "миксера",
      "миксером",
      "ручной миксер",
      "миксер (заменён венчиком)",
      "mixer",
    ]) {
      expect(matchDroppedEquipment([said], ["mixer"]), said).toEqual(["mixer"]);
    }
  });

  it("handles the words that inflect on a soft sign or a second word", () => {
    expect(matchDroppedEquipment(["аэрогрилем"], ["airfryer"])).toEqual([
      "airfryer",
    ]);
    expect(matchDroppedEquipment(["тёркой"], ["grater"])).toEqual(["grater"]);
    expect(matchDroppedEquipment(["на индукционной плите"], ["induction_hob"]))
      .toEqual(["induction_hob"]);
    expect(matchDroppedEquipment(["кухонного комбайна"], ["food_processor"]))
      .toEqual(["food_processor"]);
  });

  it("never matches outside the candidate set", () => {
    // Containment is only safe because the candidates are what the household
    // was actually missing — a proposal cannot decide to remove a requirement
    // nobody asked about.
    expect(matchDroppedEquipment(["духовка", "миксер"], ["mixer"])).toEqual([
      "mixer",
    ]);
    expect(matchDroppedEquipment(["миксер"], [])).toEqual([]);
    expect(matchDroppedEquipment(["сувид", "штуковина"], ["mixer"])).toEqual([]);
  });

  it("returns candidate order and never repeats a slug", () => {
    expect(
      matchDroppedEquipment(
        ["миксером", "аэрогриль", "миксер"],
        ["airfryer", "mixer"],
      ),
    ).toEqual(["airfryer", "mixer"]);
  });

  it("ignores blank and punctuation-only answers", () => {
    expect(matchDroppedEquipment(["", "   ", "—"], ["mixer"])).toEqual([]);
  });
});

describe("a rescale that moves no quantity (round 2, R1)", () => {
  /** Every amount unstated — «по вкусу» and «уточнить» rows only. */
  function unquantified(): RecipeDraft {
    return {
      ...emptyDraft(),
      title: "Соус на глаз",
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "порций",
      ingredients: [
        ingredient({ name: "Соль", qty: null, unit: null, note: "по вкусу" }),
        ingredient({ name: "Перец", qty: null, unit: null, note: "по вкусу" }),
      ],
      steps: [{ text: "Смешать", timerSec: null, timerMaxSec: null }],
    };
  }

  const result = applied(unquantified(), {}, {
    targetPortions: 4,
    dropEquipment: [],
  });

  it("still counts as a change — the yield really did move", () => {
    // The regression: with only the five array fields, `isEmptyDiff` said
    // «менять ничего не пришлось» directly above «Порции: 8 → 4», over a
    // change «Применить» persists.
    expect(result.diff.changedIngredients).toEqual([]);
    expect(result.diff.portionsChanged).toBe(true);
    expect(isEmptyDiff(result.diff)).toBe(false);
  });

  it("reports the range and the yield noun it dropped", () => {
    expect(result.diff.portionsRangeDropped).toBe(true);
    expect(result.diff.yieldUnitDropped).toBe(true);
    expect(result.draft.portionsMin).toBeNull();
    expect(result.draft.yieldUnit).toBeNull();
  });

  it("reports neither when there was no range or noun to lose", () => {
    const plain: RecipeDraft = {
      ...unquantified(),
      portionsMin: null,
      yieldUnit: null,
    };

    const diff = applied(plain, {}, {
      targetPortions: 4,
      dropEquipment: [],
    }).diff;

    expect(diff.portionsRangeDropped).toBe(false);
    expect(diff.yieldUnitDropped).toBe(false);
    expect(diff.portionsChanged).toBe(true);
  });

  it("reports nothing at all when the portions did not move", () => {
    const diff = applied(unquantified(), {}, NO_OPTIONS).diff;

    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.portionsChanged).toBe(false);
  });
});
