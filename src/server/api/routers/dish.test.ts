import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type OpenAI from "openai";

import {
  draftFromDetail,
  emptyDraft,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import type { AiChatClient } from "@/server/ai/openai";
import { AI_MODEL } from "@/server/ai/pricing";
import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type DbStub,
  type RecordedStatement,
  type StubResult,
} from "@/server/api/test-support";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const DISH_ID = "3f1a6d0e-0000-4000-8000-000000000901";
const OTHER_DISH_ID = "3f1a6d0e-0000-4000-8000-000000000902";
const RECIPE_ID = "3f1a6d0e-0000-4000-8000-000000000911";
const INGREDIENT_ID = "3f1a6d0e-0000-4000-8000-000000000921";
const STEP_ID = "3f1a6d0e-0000-4000-8000-000000000931";
const PANTRY_ID = "3f1a6d0e-0000-4000-8000-000000000301";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";
const OTHER_PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000202";
const CATEGORY_ID = "3f1a6d0e-0000-4000-8000-000000000102";
/** The row a save mints for an unbound ingredient. */
const NEW_PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000203";
const JOB_ID = "3f1a6d0e-0000-4000-8000-000000000701";

/** A version nobody could reach by accident — so a test proves it was bound. */
const EXPECTED_VERSION = 7;

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

const membershipRow = {
  membership: {
    id: "membership_1",
    householdId: HOUSEHOLD_ID,
    userId: "user_1",
    joinedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  household: {
    id: HOUSEHOLD_ID,
    name: "Наш дом",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DISH_ID,
    title: "NYC Cookies",
    photoUrl: null,
    tags: ["выпечка", "духовка"],
    sourceType: "photo",
    totalTimeMin: 30,
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    version: 1,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    ingredientCount: 10,
    needsReviewCount: 1,
    ...overrides,
  };
}

function detailDishRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DISH_ID,
    title: "NYC Cookies",
    photoUrl: null,
    photoKey: null,
    tags: ["выпечка", "духовка"],
    sourceType: "photo",
    sourceUrl: null,
    version: EXPECTED_VERSION,
    archivedAt: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    recipeId: RECIPE_ID,
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    totalTimeMin: 30,
    equipment: ["oven"],
    adaptedAt: null,
    adaptedNote: null,
    originalDraft: null,
    ...overrides,
  };
}

function detailIngredientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INGREDIENT_ID,
    productId: PRODUCT_ID,
    rawText: "Мука — 285 г",
    name: "Мука",
    qty: 285,
    unit: "г",
    note: null,
    isOptional: false,
    needsReview: false,
    sortOrder: 0,
    productName: "Мука",
    productIcon: "🌾",
    categoryId: CATEGORY_ID,
    pantryItemId: null,
    ...overrides,
  };
}

function detailStepRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STEP_ID,
    stepOrder: 0,
    text: "Духовка 205 °C",
    timerSec: 540,
    timerMaxSec: 660,
    ...overrides,
  };
}

/** The three reads `readDishDetail` issues, in order. */
function detailResults(
  dish: StubResult = [detailDishRow()],
  ingredients: StubResult = [detailIngredientRow()],
  steps: StubResult = [detailStepRow()],
): StubResult[] {
  return [dish, ingredients, steps];
}

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
    // Bound by default so a test about orders, titles or transactions does
    // not silently also exercise the resolution step (and, for a name the
    // reference catalog does not know, an AI call). `productId: null` is
    // opted into where the binding itself is what is under test.
    productId: PRODUCT_ID,
    ...overrides,
  };
}

/** A row of the household's own catalog, as `loadCatalog` selects it. */
function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    name: "Мука",
    icon: "🌾",
    categoryId: CATEGORY_ID,
    defaultUnit: "кг",
    aliases: [],
    ...overrides,
  };
}

/** One department, so the reference catalog has somewhere to file a product. */
function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: CATEGORY_ID, name: "Бакалея", sortOrder: 5, ...overrides };
}

/** What a freshly inserted product returns. */
function createdProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NEW_PRODUCT_ID,
    name: "Мука",
    icon: "🌾",
    categoryId: CATEGORY_ID,
    defaultUnit: "кг",
    aliases: [],
    ...overrides,
  };
}

/** «Мука» as the built-in reference entry mints it. */
function referenceProductRow() {
  return createdProductRow();
}

/**
 * The two reads the resolution step makes for a draft with unbound rows: the
 * household's catalog (empty here, so the reference list decides) and its
 * departments.
 */
const RESOLVE_READS: StubResult[] = [
  [membershipRow],
  [],
  [categoryRow()],
];

/** The 23505 a unique index raises, wrapped the way drizzle wraps it. */
function uniqueViolation() {
  return Object.assign(new Error("duplicate key"), {
    cause: { code: "23505" },
  });
}

/** A batched enrichment answer, as the API would shape it. */
function enrichmentClient(
  items: { name: string; icon: string; categoryId: string; unit: string }[],
): { fake: AiChatClient; calls: CreateParams[] } {
  return fakeOpenai(JSON.stringify({ items }));
}

/** A response that is not the JSON the schema asks for. */
function brokenEnrichmentClient(): {
  fake: AiChatClient;
  calls: CreateParams[];
} {
  return fakeOpenai("не json");
}

function fakeOpenai(content: string): {
  fake: AiChatClient;
  calls: CreateParams[];
} {
  const calls: CreateParams[] = [];

  return {
    calls,
    fake: {
      chat: {
        completions: {
          create(params) {
            calls.push(params);
            return Promise.resolve({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1_787_000_000,
              model: AI_MODEL,
              usage: {
                prompt_tokens: 400,
                completion_tokens: 30,
                total_tokens: 430,
              },
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  logprobs: null,
                  message: {
                    role: "assistant",
                    content,
                    refusal: null,
                  },
                },
              ],
            } satisfies Completion);
          },
        },
      },
    },
  };
}

/** A caller whose context hands out `fake` instead of refusing to build one. */
function aiCallerWith(results: StubResult[], fake: AiChatClient) {
  const stub = createDbStub(results);
  return {
    caller: createCaller(signedInContext(stub.db, () => fake)),
    stub,
  };
}

function draft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    ...emptyDraft(),
    title: "NYC Cookies",
    tags: ["выпечка"],
    sourceType: "photo",
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    totalTimeMin: 30,
    equipment: ["oven"],
    ingredients: [ingredient()],
    steps: [{ text: "Смешать сухие", timerSec: null, timerMaxSec: null }],
    ...overrides,
  };
}

function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

function compile(clause: unknown): string {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL()).sql;
}

/** Keeps the bound parameters too — the only way to pin a literal value. */
function compileWithParams(clause: unknown): {
  sql: string;
  params: unknown[];
} {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL());
}

/**
 * The tenancy guard (VISION §6.7). Local to this file on purpose — every
 * router test carries its own copy (see `pantry.test.ts`), so a shared helper
 * cannot be quietly weakened for all of them at once.
 *
 * **The bound value is asserted, not only the column name.** A predicate that
 * mentions `household_id` while binding the wrong in-scope string — a recipe
 * id, a dish id — compiles to text this assertion would otherwise accept, and
 * that is exactly the shape a bad refactor takes.
 */
function expectScopedByHousehold(
  statement: RecordedStatement | undefined,
  householdId: string = HOUSEHOLD_ID,
) {
  const compiled = compileWithParams(statement?.wheres[0]);
  expect(compiled.sql).toContain('"household_id"');
  expect(compiled.params).toContain(householdId);
}

describe("dish.list", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.list()).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.dish.list()).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("returns the card's fields, counts included", async () => {
    const { caller } = callerWith([[membershipRow], [listRow()]]);

    await expect(caller.dish.list()).resolves.toEqual([
      {
        id: DISH_ID,
        title: "NYC Cookies",
        photoUrl: null,
        tags: ["выпечка", "духовка"],
        sourceType: "photo",
        totalTimeMin: 30,
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: "печений",
        ingredientCount: 10,
        needsReviewCount: 1,
        version: 1,
        createdAt: new Date("2026-08-20T10:00:00.000Z"),
      },
    ]);
  });

  it("reads only this household's dishes", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.list();

    expectScopedByHousehold(stub.statements[1]);
    expect(compileWithParams(stub.statements[1]?.wheres[0]).params).toContain(
      HOUSEHOLD_ID,
    );
  });

  it("hides archived dishes", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.list();

    expect(compile(stub.statements[1]?.wheres[0])).toContain(
      '"archived_at" is null',
    );
  });

  it("scopes both joins by household, not by an argument about another table", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.list();

    const [recipesJoin, ingredientsJoin] = stub.statements[1]?.joins ?? [];
    expect(compile(recipesJoin)).toContain('"household_id"');
    expect(compile(ingredientsJoin)).toContain('"household_id"');
    expect(compileWithParams(ingredientsJoin).params).toContain(HOUSEHOLD_ID);
  });

  it("orders newest first, with the id as a stable tiebreak", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.list();

    expect(compile(stub.statements[1]?.orderBys[0])).toBe(
      '"dishes"."created_at" desc',
    );
    expect(compile(stub.statements[1]?.orderBys[1])).toBe('"dishes"."id" desc');
  });

  it("counts the ingredients and the amber chips in one grouped read", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.list();

    const statement = stub.statements[1];
    const fields = statement?.fields as Record<string, unknown>;
    // The exact text, not a substring: under the LEFT JOIN a `count(*)` would
    // report 1 for a dish with no ingredients at all, and a `needs_review` →
    // `is_optional` slip would put S6's amber dot on the wrong cards. Both
    // mutants compile and pass every other assertion in this file.
    expect(compile(fields.ingredientCount)).toBe(
      'count("recipe_ingredients"."id")::int',
    );
    expect(compile(fields.needsReviewCount)).toBe(
      'count(*) filter (where "recipe_ingredients"."needs_review")::int',
    );
    expect(compile(statement?.groupBys[0])).toBe('"dishes"."id"');
    expect(compile(statement?.groupBys[1])).toBe('"recipes"."id"');
  });
});

describe("dish.listArchived", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.listArchived()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("shows exactly what `list` hides, scoped the same way", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.listArchived();

    expectScopedByHousehold(stub.statements[1]);
    expect(compile(stub.statements[1]?.wheres[0])).toContain(
      '"archived_at" is not null',
    );
  });

  it("orders by when it was archived, most recent first", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.dish.listArchived();

    expect(compile(stub.statements[1]?.orderBys[0])).toBe(
      '"dishes"."archived_at" desc',
    );
  });
});

describe("dish.get", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.get({ id: DISH_ID })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("assembles the dish, its recipe, its ingredients and its steps", async () => {
    const { caller } = callerWith([[membershipRow], ...detailResults()]);

    await expect(caller.dish.get({ id: DISH_ID })).resolves.toEqual({
      id: DISH_ID,
      title: "NYC Cookies",
      photoUrl: null,
      photoKey: null,
      tags: ["выпечка", "духовка"],
      sourceType: "photo",
      sourceUrl: null,
      version: EXPECTED_VERSION,
      archivedAt: null,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      updatedAt: new Date("2026-08-20T10:00:00.000Z"),
      recipe: {
        id: RECIPE_ID,
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: "печений",
        totalTimeMin: 30,
        equipment: ["oven"],
        adaptedAt: null,
        adaptedNote: null,
        hasOriginalDraft: false,
      },
      ingredients: [
        {
          id: INGREDIENT_ID,
          productId: PRODUCT_ID,
          productName: "Мука",
          productIcon: "🌾",
          categoryId: CATEGORY_ID,
          rawText: "Мука — 285 г",
          name: "Мука",
          qty: 285,
          unit: "г",
          note: null,
          isOptional: false,
          needsReview: false,
          sortOrder: 0,
          inPantry: false,
        },
      ],
      steps: [
        {
          id: STEP_ID,
          stepOrder: 0,
          text: "Духовка 205 °C",
          timerSec: 540,
          timerMaxSec: 660,
        },
      ],
    });
  });

  it("reports `hasOriginalDraft` without shipping the draft itself", async () => {
    const { caller } = callerWith([
      [membershipRow],
      ...detailResults([detailDishRow({ originalDraft: { title: "x" } })]),
    ]);

    const dish = await caller.dish.get({ id: DISH_ID });

    expect(dish.recipe.hasOriginalDraft).toBe(true);
    expect(JSON.stringify(dish)).not.toContain("originalDraft");
  });

  it("refuses another household's id before any second query runs", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.dish.get({ id: OTHER_DISH_ID })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    // The membership lookup and the dish read, and nothing else.
    expect(stub.statements).toHaveLength(2);
  });

  it("scopes all three reads by household", async () => {
    const { caller, stub } = callerWith([[membershipRow], ...detailResults()]);

    await caller.dish.get({ id: DISH_ID });

    expectScopedByHousehold(stub.statements[1]);
    expectScopedByHousehold(stub.statements[2]);
    expectScopedByHousehold(stub.statements[3]);
  });

  it("carries the household into the pantry join, not just the WHERE", async () => {
    const { caller, stub } = callerWith([[membershipRow], ...detailResults()]);

    await caller.dish.get({ id: DISH_ID });

    const [productsJoin, pantryJoin] = stub.statements[2]?.joins ?? [];
    expect(compile(productsJoin)).toContain('"household_id"');
    const compiled = compileWithParams(pantryJoin);
    expect(compiled.sql).toContain('"pantry_items"."household_id"');
    expect(compiled.params).toContain(HOUSEHOLD_ID);
  });

  it("reads «дома есть ✓» off the pantry join", async () => {
    const { caller } = callerWith([
      [membershipRow],
      ...detailResults(undefined, [
        detailIngredientRow({ pantryItemId: PANTRY_ID }),
      ]),
    ]);

    const dish = await caller.dish.get({ id: DISH_ID });

    expect(dish.ingredients[0]?.inPantry).toBe(true);
  });

  it("leaves an unbound ingredient unbound, and never «дома есть»", async () => {
    const { caller } = callerWith([
      [membershipRow],
      ...detailResults(undefined, [
        detailIngredientRow({
          productId: null,
          productName: null,
          productIcon: null,
          categoryId: null,
          pantryItemId: null,
        }),
      ]),
    ]);

    const dish = await caller.dish.get({ id: DISH_ID });

    expect(dish.ingredients[0]).toMatchObject({
      productId: null,
      productName: null,
      inPantry: false,
    });
  });

  it("degrades a stored unit the app no longer knows to «unstated»", async () => {
    // One bad row must not fail the whole dish's output validation — the same
    // rule `cart.ts`'s FALLBACK_UNIT encodes.
    const { caller } = callerWith([
      [membershipRow],
      ...detailResults(undefined, [detailIngredientRow({ unit: "мешок" })]),
    ]);

    const dish = await caller.dish.get({ id: DISH_ID });

    expect(dish.ingredients[0]?.unit).toBeNull();
    expect(dish.ingredients[0]?.qty).toBe(285);
  });

  it("keeps a recipe-only unit the cart does not know", async () => {
    const { caller } = callerWith([
      [membershipRow],
      ...detailResults(undefined, [
        detailIngredientRow({ qty: 0.75, unit: "ч.л." }),
      ]),
    ]);

    const dish = await caller.dish.get({ id: DISH_ID });

    expect(dish.ingredients[0]?.unit).toBe("ч.л.");
  });

  it("orders children by their stored order, with the id as a tiebreak", async () => {
    const { caller, stub } = callerWith([[membershipRow], ...detailResults()]);

    await caller.dish.get({ id: DISH_ID });

    expect(compile(stub.statements[2]?.orderBys[0])).toBe(
      '"recipe_ingredients"."sort_order" asc',
    );
    expect(compile(stub.statements[2]?.orderBys[1])).toBe(
      '"recipe_ingredients"."id" asc',
    );
    expect(compile(stub.statements[3]?.orderBys[0])).toBe(
      '"recipe_steps"."step_order" asc',
    );
  });
});

describe("dish.create", () => {
  /**
   * The statements a save issues when every ingredient row already names a
   * product: the ownership check, then the four writes.
   *
   * The default `ingredient()` is **bound** on purpose. Task 4.2 put a
   * resolution step in front of the transaction, and leaving the shared
   * fixture unbound would drag every unrelated test through the reference
   * catalog and (for a name it does not know) an AI call. Resolution has its
   * own describe below, with queues that spell out what it reads.
   */
  const CREATE_PREAMBLE: StubResult[] = [
    [membershipRow],
    [{ id: PRODUCT_ID }],
    [{ id: DISH_ID }],
    [{ id: RECIPE_ID }],
    [],
    [],
  ];

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.dish.create({ draft: draft(), originalDraft: null, jobId: null }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("refuses a recipe with no ingredients", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(
      caller.dish.create({
        draft: draft({ ingredients: [] }),
        originalDraft: null,
        jobId: null,
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    expect(stub.statements).toHaveLength(1);
  });

  it("writes the dish, its recipe and both child tables in one transaction", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements.slice(2, 6).map((s) => [s.kind, s.table])).toEqual([
      ["insert", "dishes"],
      ["insert", "recipes"],
      ["insert", "recipe_ingredients"],
      ["insert", "recipe_steps"],
    ]);
    for (const statement of stub.statements.slice(2, 6)) {
      expect(statement.txDepth).toBe(1);
    }
  });

  it("stamps the household and the author from the context, never the input", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements[2]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      createdBy: "user_1",
      title: "NYC Cookies",
      normalizedTitle: "nyc cookies",
      sourceType: "photo",
    });
    expect(stub.statements[3]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      dishId: DISH_ID,
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "печений",
    });
  });

  it("stores the import's own draft verbatim, and nothing for a manual dish", async () => {
    const original = draft({ title: "NYC Cookies (импорт)" });
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: original,
      jobId: null,
    });

    expect(stub.statements[3]?.values).toMatchObject({
      originalDraft: { title: "NYC Cookies (импорт)" },
    });

    const manual = callerWith([...CREATE_PREAMBLE, ...detailResults()]);
    await manual.caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });
    expect(manual.stub.statements[3]?.values).toMatchObject({
      originalDraft: null,
    });
  });

  it("mints fresh 0..n-1 orders and recomputes needsReview", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({
        ingredients: [
          ingredient({ name: "Мука" }),
          // Claims to be fine, but states no quantity: the chip goes back on.
          ingredient({
            name: "Кукурузный крахмал",
            qty: null,
            unit: null,
            needsReview: false,
          }),
          // No quantity either, but «по вкусу» is a complete instruction.
          ingredient({
            name: "Соль",
            qty: null,
            unit: null,
            note: "по вкусу",
            needsReview: true,
          }),
        ],
        steps: [
          { text: "Смешать", timerSec: null, timerMaxSec: null },
          { text: "Печь", timerSec: 540, timerMaxSec: 660 },
        ],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements[4]?.values).toEqual([
      expect.objectContaining({
        householdId: HOUSEHOLD_ID,
        recipeId: RECIPE_ID,
        name: "Мука",
        sortOrder: 0,
        needsReview: false,
      }),
      expect.objectContaining({
        name: "Кукурузный крахмал",
        sortOrder: 1,
        needsReview: true,
      }),
      expect.objectContaining({
        name: "Соль",
        sortOrder: 2,
        needsReview: false,
      }),
    ]);
    expect(stub.statements[5]?.values).toEqual([
      expect.objectContaining({
        householdId: HOUSEHOLD_ID,
        recipeId: RECIPE_ID,
        stepOrder: 0,
        text: "Смешать",
      }),
      expect.objectContaining({ stepOrder: 1, timerSec: 540, timerMaxSec: 660 }),
    ]);
  });

  it("issues no step insert for a recipe with no steps", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: PRODUCT_ID }],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({ steps: [] }),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements.filter((s) => s.table === "recipe_steps")).toEqual([
      expect.objectContaining({ kind: "select" }),
    ]);
  });

  it("verifies a client-sent productId against this household's catalog first", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    const check = stub.statements[1];
    expect(check?.table).toBe("products");
    // Outside the transaction: this is where the enrichment call runs, and it
    // must not hold row locks open for a 15-40 s round trip.
    expect(check?.txDepth).toBe(0);
    expectScopedByHousehold(check);
    expect(compileWithParams(check?.wheres[0]).params).toContain(PRODUCT_ID);
  });

  it("refuses a product outside the caller's catalog before any write", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(
      caller.dish.create({
        draft: draft({
          ingredients: [ingredient({ productId: OTHER_PRODUCT_ID })],
        }),
        originalDraft: null,
        jobId: null,
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    expect(stub.statements).toHaveLength(2);
    expect(stub.statements.every((s) => s.kind === "select")).toBe(true);
  });

  it("refuses a mixed draft where only one of two bound ids comes back", async () => {
    // The set-size comparison, not "did anything come back": one id belongs
    // to this household and one does not, and the save must still be refused.
    const { caller, stub } = callerWith([[membershipRow], [{ id: PRODUCT_ID }]]);

    await expect(
      caller.dish.create({
        draft: draft({
          ingredients: [
            ingredient({ productId: PRODUCT_ID }),
            ingredient({ productId: OTHER_PRODUCT_ID }),
          ],
        }),
        originalDraft: null,
        jobId: null,
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    expect(stub.statements).toHaveLength(2);
    expect(stub.statements.every((s) => s.kind === "select")).toBe(true);
  });

  it("accepts two rows bound to the same product", async () => {
    // «Молоко в тесто» + «молоко в глазурь» is a real recipe. Without the
    // dedupe the check compares two requested ids against one catalog row and
    // rejects a perfectly legal save.
    const { caller } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await expect(
      caller.dish.create({
        draft: draft({
          ingredients: [
            ingredient({ productId: PRODUCT_ID }),
            ingredient({ productId: PRODUCT_ID }),
          ],
        }),
        originalDraft: null,
        jobId: null,
      }),
    ).resolves.toBeDefined();
  });

  it("skips the catalog check when every row is unbound", async () => {
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      [referenceProductRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
      originalDraft: null,
      jobId: null,
    });

    // No `IN (…)` probe at all — the first read is the catalog the matcher
    // needs, not the ownership check for ids nobody sent.
    expect(compileWithParams(stub.statements[1]?.wheres[0]).params).toEqual([
      HOUSEHOLD_ID,
    ]);
  });

  it("marks the import job consumed, scoped by household", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: JOB_ID,
    });

    const job = stub.statements[6];
    expect(job?.table).toBe("ai_jobs");
    expect(job?.kind).toBe("update");
    expectScopedByHousehold(job);
    expect(compileWithParams(job?.wheres[0]).params).toEqual([
      JOB_ID,
      HOUSEHOLD_ID,
    ]);

    const values = job?.values as Record<string, unknown>;
    const compiled = compileWithParams(values.outputJson);
    // `coalesce` matters: `jsonb_set` on NULL returns NULL, which would erase
    // the ledger entry instead of annotating it.
    expect(compiled.sql).toContain("coalesce(");
    expect(compiled.sql).toContain("jsonb_set(");
    expect(compiled.params).toContain(DISH_ID);
  });

  it("touches no job when the save did not come from an import", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
  });

  it("returns the saved aggregate, read back after the commit", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    expect(result.dish.id).toBe(DISH_ID);
    // Every row was already bound, so nothing was minted and nothing degraded.
    expect(result.createdProducts).toEqual([]);
    expect(result.aiFailed).toBe(false);
    for (const statement of stub.statements.slice(6)) {
      expect(statement.txDepth).toBe(0);
    }
  });
});

describe("dish.create — resolving unbound ingredients", () => {
  it("binds a reference-catalog name for free, with no AI call at all", async () => {
    // `unusableOpenai` is the assertion: the default context throws the
    // moment anything reaches for a client, so a reference hit that quietly
    // started paying for an icon would fail here rather than in the bill.
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      [referenceProductRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
      originalDraft: null,
      jobId: null,
    });

    const [catalogRead, categoryRead, productInsert] = stub.statements.slice(
      1,
      4,
    );
    expect([catalogRead?.kind, catalogRead?.table]).toEqual([
      "select",
      "products",
    ]);
    expect(catalogRead?.txDepth).toBe(0);
    expectScopedByHousehold(catalogRead);
    expect(categoryRead?.table).toBe("categories");
    expectScopedByHousehold(categoryRead);

    // The savepoint (D14): a 23505 without one aborts the whole enclosing
    // transaction, and every following statement dies with 25P02.
    expect(productInsert?.txDepth).toBe(2);
    expect(productInsert?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      createdBy: "user_1",
      // The reference entry's own spelling and unit, not the recipe's wording.
      name: "Мука",
      normalizedName: "мука",
      icon: "🌾",
      defaultUnit: "кг",
      categoryId: CATEGORY_ID,
    });

    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
    expect(result.createdProducts).toEqual([
      expect.objectContaining({ id: NEW_PRODUCT_ID, name: "Мука" }),
    ]);
    expect(result.aiFailed).toBe(false);
  });

  it("writes the resolved id into the ingredient row, not the client's null", async () => {
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      [referenceProductRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements[6]?.values).toEqual([
      expect.objectContaining({ name: "Мука", productId: NEW_PRODUCT_ID }),
    ]);
  });

  it("mints one product for two rows that name the same ingredient", async () => {
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      [referenceProductRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({
        ingredients: [
          ingredient({ name: "Мука", productId: null }),
          // The same product, spelled the way the second line of a recipe
          // spells it. One insert, two bindings.
          ingredient({ name: "мука", productId: null, rawText: "мука — 50 г" }),
        ],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(
      stub.statements.filter((s) => s.kind === "insert" && s.table === "products"),
    ).toHaveLength(1);
    expect(stub.statements[6]?.values).toEqual([
      expect.objectContaining({ productId: NEW_PRODUCT_ID }),
      expect.objectContaining({ productId: NEW_PRODUCT_ID }),
    ]);
  });

  it("binds to the household's own row before it considers minting one", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [catalogRow({ name: "Мука" })],
      [categoryRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
      originalDraft: null,
      jobId: null,
    });

    expect(
      stub.statements.some((s) => s.kind === "insert" && s.table === "products"),
    ).toBe(false);
    expect(stub.statements[5]?.values).toEqual([
      expect.objectContaining({ productId: PRODUCT_ID }),
    ]);
    expect(result.createdProducts).toEqual([]);
  });

  it("binds a staple the household owns under another spelling, minting nothing", async () => {
    // The reference catalog would happily hand back «Помидоры» here. The
    // household already owns that product as «Томаты», and the unique index —
    // `normalized_name` only — would not stop the second row.
    const { caller, stub } = callerWith([
      [membershipRow],
      [catalogRow({ name: "Томаты" })],
      [categoryRow()],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "Помидоры", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(
      stub.statements.some((s) => s.kind === "insert" && s.table === "products"),
    ).toBe(false);
    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
    expect(stub.statements[5]?.values).toEqual([
      expect.objectContaining({ name: "Помидоры", productId: PRODUCT_ID }),
    ]);
    expect(result.createdProducts).toEqual([]);
  });

  it("pairs each unknown name with its own enrichment, not with the row's index", async () => {
    // A draft that mixes a reference hit with an unknown name is the only
    // shape where `unknown[]`'s index space and `enrichment.values[]`'s can
    // disagree: «Мука» resolves for free and is never sent, so «Буррата» is
    // question 0 of the batch while being row 1 of the draft.
    const { fake, calls } = enrichmentClient([
      { name: "Буррата", icon: "🧀", categoryId: CATEGORY_ID, unit: "шт" },
    ]);
    const { caller, stub } = aiCallerWith(
      [
        ...RESOLVE_READS,
        [{ minute: 0, day: 0 }],
        [{ id: JOB_ID }],
        [],
        [referenceProductRow()],
        [createdProductRow({ id: OTHER_PRODUCT_ID, name: "Буррата", icon: "🧀" })],
        [{ id: DISH_ID }],
        [{ id: RECIPE_ID }],
        [],
        [],
        ...detailResults(),
      ],
      fake,
    );

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [
          ingredient({ name: "Мука", productId: null }),
          ingredient({ name: "Буррата", productId: null }),
        ],
      }),
      originalDraft: null,
      jobId: null,
    });

    const prompt = String(calls[0]?.messages[1]?.content);
    expect(prompt).toContain("Буррата");
    expect(prompt).not.toContain("Мука");

    const inserts = stub.statements
      .filter((s) => s.kind === "insert" && s.table === "products")
      .map((s) => s.values);
    expect(inserts).toEqual([
      expect.objectContaining({ name: "Мука", icon: "🌾" }),
      expect.objectContaining({
        name: "Буррата",
        icon: "🧀",
        defaultUnit: "шт",
      }),
    ]);
    expect(result.aiFailed).toBe(false);
  });

  it("saves even when the OpenAI client cannot be built at all", async () => {
    // `callerWith`'s context hands out `unusableOpenai`, which throws. That is
    // the failure `enrichProducts` cannot catch for itself — a malformed
    // OPENAI_API_KEY, say. A *missing* key never reaches here: `env()`
    // validates the whole schema on its first call and `db()` calls it, so the
    // request dies building its context.
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      [{ minute: 0, day: 0 }],
      [{ id: JOB_ID }],
      [],
      [createdProductRow({ name: "Буррата", icon: "🛒" })],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "Буррата", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(result.dish.id).toBe(DISH_ID);
    expect(result.aiFailed).toBe(true);
    expect(
      stub.statements.find(
        (s) => s.kind === "insert" && s.table === "products",
      )?.values,
    ).toMatchObject({ name: "Буррата", icon: "🛒", defaultUnit: "шт" });

    const failed = stub.statements.find(
      (s) => s.kind === "update" && s.table === "ai_jobs",
    );
    const values = failed?.values as Record<string, unknown>;
    expect(values.status).toBe("error");
    // Nothing was billed — the call never left the process.
    expect(values.costUsd).toBe("0.000000");
  });

  it("rethrows a non-unique insert error instead of masking it", async () => {
    // Only a 23505 means "someone else got there first". Anything else is a
    // real failure, and swallowing it would surface as the misleading
    // «Product insert returned no row».
    const fk = Object.assign(new Error("fk violation"), {
      cause: { code: "23503" },
    });
    const { caller } = callerWith([...RESOLVE_READS, fk]);

    await expect(
      caller.dish.create({
        draft: draft({ ingredients: [ingredient({ productId: null })] }),
        originalDraft: null,
        jobId: null,
      }),
    ).rejects.toThrow("fk violation");
  });

  it("is an INTERNAL_SERVER_ERROR when the recovery read finds nothing either", async () => {
    const { caller } = callerWith([...RESOLVE_READS, uniqueViolation(), []]);

    await expect(
      caller.dish.create({
        draft: draft({ ingredients: [ingredient({ productId: null })] }),
        originalDraft: null,
        jobId: null,
      }),
    ).rejects.toSatisfy(hasCode("INTERNAL_SERVER_ERROR"));
  });

  it("neither enriches nor creates a row whose name could never be a product", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "—", rawText: "—", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    // Not one read: a row that can never become a product is not worth the
    // catalog either. It is saved unbound, which is a first-class state.
    expect(stub.statements[1]?.table).toBe("dishes");
    expect(stub.statements[3]?.values).toEqual([
      expect.objectContaining({ name: "—", productId: null }),
    ]);
    expect(result.createdProducts).toEqual([]);
    expect(result.aiFailed).toBe(false);
  });

  it("spends exactly one ai_jobs row however many names are unknown", async () => {
    const { fake, calls } = enrichmentClient([
      { name: "Буррата", icon: "🧀", categoryId: CATEGORY_ID, unit: "шт" },
      { name: "Дукка", icon: "🥜", categoryId: CATEGORY_ID, unit: "г" },
    ]);
    const { caller, stub } = aiCallerWith(
      [
        ...RESOLVE_READS,
        [{ minute: 0, day: 0 }],
        [{ id: JOB_ID }],
        [],
        [createdProductRow({ name: "Буррата", icon: "🧀" })],
        [createdProductRow({ id: OTHER_PRODUCT_ID, name: "Дукка", icon: "🥜" })],
        [{ id: DISH_ID }],
        [{ id: RECIPE_ID }],
        [],
        [],
        ...detailResults(),
      ],
      fake,
    );

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [
          ingredient({ name: "Буррата", productId: null }),
          ingredient({ name: "Дукка", productId: null }),
        ],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(calls).toHaveLength(1);
    const jobInserts = stub.statements.filter(
      (s) => s.kind === "insert" && s.table === "ai_jobs",
    );
    expect(jobInserts).toHaveLength(1);
    // The ledger row, and therefore the call it fronts, is written before any
    // transaction is opened.
    expect(jobInserts[0]?.txDepth).toBe(0);
    expect(jobInserts[0]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      userId: "user_1",
      type: "product_enrich",
      status: "running",
    });

    expect(result.createdProducts).toHaveLength(2);
    expect(result.aiFailed).toBe(false);
  });

  it("uses the model's icon, department and unit for the product it mints", async () => {
    const { fake } = enrichmentClient([
      { name: "Буррата", icon: "🧀", categoryId: CATEGORY_ID, unit: "шт" },
    ]);
    const { caller, stub } = aiCallerWith(
      [
        ...RESOLVE_READS,
        [{ minute: 0, day: 0 }],
        [{ id: JOB_ID }],
        [],
        [createdProductRow({ name: "Буррата", icon: "🧀" })],
        [{ id: DISH_ID }],
        [{ id: RECIPE_ID }],
        [],
        [],
        ...detailResults(),
      ],
      fake,
    );

    await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "Буррата", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    const insert = stub.statements.find(
      (s) => s.kind === "insert" && s.table === "products",
    );
    expect(insert?.values).toMatchObject({
      name: "Буррата",
      icon: "🧀",
      categoryId: CATEGORY_ID,
      defaultUnit: "шт",
      aliases: [],
    });

    const done = stub.statements.find(
      (s) => s.kind === "update" && s.table === "ai_jobs",
    );
    expect(done?.values).toMatchObject({ status: "done" });
    expectScopedByHousehold(done);
  });

  it("still saves when the model fails, with fallbacks and the cost recorded", async () => {
    const { fake } = brokenEnrichmentClient();
    const { caller, stub } = aiCallerWith(
      [
        ...RESOLVE_READS,
        [{ minute: 0, day: 0 }],
        [{ id: JOB_ID }],
        [],
        [createdProductRow({ name: "Буррата", icon: "🛒" })],
        [{ id: DISH_ID }],
        [{ id: RECIPE_ID }],
        [],
        [],
        ...detailResults(),
      ],
      fake,
    );

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "Буррата", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    const insert = stub.statements.find(
      (s) => s.kind === "insert" && s.table === "products",
    );
    expect(insert?.values).toMatchObject({
      name: "Буррата",
      icon: "🛒",
      defaultUnit: "шт",
      categoryId: CATEGORY_ID,
    });

    const failed = stub.statements.find(
      (s) => s.kind === "update" && s.table === "ai_jobs",
    );
    const values = failed?.values as Record<string, unknown>;
    expect(values.status).toBe("error");
    // A response that came back and then failed validation was still billed;
    // a ledger that only counts successes under-reports exactly when things
    // go wrong.
    expect(values.costUsd).toMatch(/^\d+\.\d{6}$/);
    expect(values.costUsd).not.toBe("0.000000");

    expect(result.dish.id).toBe(DISH_ID);
    expect(result.aiFailed).toBe(true);
  });

  it("saves with fallbacks when the rate limiter refuses, without a job row", async () => {
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      // Well past AI_LIMIT_PER_MINUTE: the limiter says no, and the save has
      // to survive that — the user has just reviewed a whole recipe.
      [{ minute: 99, day: 99 }],
      [createdProductRow({ name: "Буррата", icon: "🛒" })],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({
        ingredients: [ingredient({ name: "Буррата", productId: null })],
      }),
      originalDraft: null,
      jobId: null,
    });

    expect(
      stub.statements.some((s) => s.kind === "insert" && s.table === "ai_jobs"),
    ).toBe(false);
    expect(result.dish.id).toBe(DISH_ID);
    expect(result.aiFailed).toBe(true);
    expect(result.createdProducts).toHaveLength(1);
  });

  it("recovers from a lost insert race by binding the winner's row", async () => {
    const { caller, stub } = callerWith([
      ...RESOLVE_READS,
      uniqueViolation(),
      [catalogRow({ name: "Мука" })],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
      originalDraft: null,
      jobId: null,
    });

    // The recovery read runs in the enclosing transaction, *outside* the
    // savepoint the violation rolled back.
    const recovery = stub.statements[4];
    expect([recovery?.kind, recovery?.table]).toEqual(["select", "products"]);
    expect(recovery?.txDepth).toBe(1);
    expect(stub.statements[7]?.values).toEqual([
      expect.objectContaining({ productId: PRODUCT_ID }),
    ]);
    // Someone else minted it, so «Создано N новых продуктов» must not claim it.
    expect(result.createdProducts).toEqual([]);
  });
});

describe("dish.update", () => {
  const LOCK_ROW: StubResult = [{ version: EXPECTED_VERSION }];
  /**
   * Version pre-check, ownership check, then the transaction: the lock, the
   * recipe lookup, both parent updates, both deletes, both inserts.
   */
  const UPDATE_PREAMBLE: StubResult[] = [
    [membershipRow],
    LOCK_ROW,
    [{ id: PRODUCT_ID }],
    LOCK_ROW,
    [{ id: RECIPE_ID }],
    [{ id: DISH_ID }],
    [],
    [],
    [],
    [],
    [],
  ];

  function updateInput(overrides: Partial<RecipeDraft> = {}) {
    return {
      id: DISH_ID,
      expectedVersion: EXPECTED_VERSION,
      draft: draft(overrides),
    };
  }

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("reads the version before it resolves anything, and fails fast on a stale one", async () => {
    // The point of the pre-check: a stale editor is refused *before* the save
    // can mint products and spend an AI call for a write that cannot land.
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(
      caller.dish.update({
        ...updateInput(),
        draft: draft({ ingredients: [ingredient({ productId: null })] }),
      }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));

    expect(stub.statements).toHaveLength(2);
    const check = stub.statements[1];
    expect([check?.kind, check?.table]).toEqual(["select", "dishes"]);
    expect(check?.txDepth).toBe(0);
    expect(check?.lock).toBeNull();
    expectScopedByHousehold(check);
    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
  });

  it("is NOT_FOUND before any resolution when the dish is not this household's", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    expect(stub.statements).toHaveLength(2);
  });

  it("locks the dish row before it reads its version", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const lock = stub.statements[3];
    expect(lock?.table).toBe("dishes");
    expect(lock?.lock).toEqual({ strength: "update", config: undefined });
    expect(lock?.txDepth).toBe(1);
    expectScopedByHousehold(lock);
  });

  it("is NOT_FOUND for a dish that disappears between the two reads", async () => {
    const { caller } = callerWith([
      [membershipRow],
      LOCK_ROW,
      [{ id: PRODUCT_ID }],
      [],
    ]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });

  it("is CONFLICT when the dish moved on between the two reads", async () => {
    const { caller } = callerWith([
      [membershipRow],
      LOCK_ROW,
      [{ id: PRODUCT_ID }],
      [{ version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
  });

  it("rewrites normalized_title alongside every other column it owns", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput({ title: "  Тёплый  Салат " }));

    // A title whose canonical form differs visibly from the input, so the
    // assertion cannot pass by echoing. A stale `normalized_title` silently
    // breaks `dishes_householdId_normalizedTitle_idx` — the seed's own
    // idempotency check today, the assistant's dish lookup in task 6.1.
    expect(stub.statements[5]?.values).toMatchObject({
      title: "Тёплый  Салат",
      normalizedTitle: "теплый салат",
      photoUrl: null,
      photoKey: null,
      tags: ["выпечка"],
      sourceType: "photo",
      sourceUrl: null,
    });
  });

  it("looks the recipe up scoped by dish AND household", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const lookup = stub.statements[4];
    expect(lookup?.table).toBe("recipes");
    expectScopedByHousehold(lookup);
    expect(compileWithParams(lookup?.wheres[0]).params).toEqual([
      DISH_ID,
      HOUSEHOLD_ID,
    ]);
  });

  it("bumps the version by exactly one", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const values = stub.statements[5]?.values as Record<string, unknown>;
    // Drizzle inlines the numeric literal rather than binding it, so the
    // compiled text is where «exactly one» is pinned.
    expect(compile(values.version)).toBe('"dishes"."version" + 1');
    expect(compile(values.updatedAt)).toContain("now()");
  });

  it("binds the expected version into the write, whatever it is", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const compiled = compileWithParams(stub.statements[5]?.wheres[0]);
    expect(compiled.sql).toContain('"version"');
    expect(compiled.params).toEqual([DISH_ID, HOUSEHOLD_ID, EXPECTED_VERSION]);

    // A different token must actually reach the statement — a hardcoded
    // constant would pass the assertion above by coincidence.
    const other = callerWith([
      [membershipRow],
      [{ version: 42 }],
      [{ id: PRODUCT_ID }],
      [{ version: 42 }],
      [{ id: RECIPE_ID }],
      [{ id: DISH_ID }],
      [],
      [],
      [],
      [],
      [],
      ...detailResults(),
    ]);
    await other.caller.dish.update({ ...updateInput(), expectedVersion: 42 });
    expect(compileWithParams(other.stub.statements[5]?.wheres[0]).params).toEqual(
      [DISH_ID, HOUSEHOLD_ID, 42],
    );
  });

  it("is CONFLICT when the guarded write matches nothing", async () => {
    const { caller } = callerWith([
      [membershipRow],
      LOCK_ROW,
      [{ id: PRODUCT_ID }],
      LOCK_ROW,
      [{ id: RECIPE_ID }],
      [],
    ]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
  });

  it("replaces the children, deleting them scoped by recipe AND household", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const [ingredientsDelete, stepsDelete] = [
      stub.statements[7],
      stub.statements[8],
    ];
    expect(ingredientsDelete?.kind).toBe("delete");
    expect(ingredientsDelete?.table).toBe("recipe_ingredients");
    const ingredientsWhere = compileWithParams(ingredientsDelete?.wheres[0]);
    expect(ingredientsWhere.sql).toContain('"recipe_id"');
    expect(ingredientsWhere.sql).toContain('"household_id"');
    expect(ingredientsWhere.params).toEqual([RECIPE_ID, HOUSEHOLD_ID]);

    expect(stepsDelete?.table).toBe("recipe_steps");
    const stepsWhere = compileWithParams(stepsDelete?.wheres[0]);
    expect(stepsWhere.sql).toContain('"recipe_id"');
    expect(stepsWhere.sql).toContain('"household_id"');
    expect(stepsWhere.params).toEqual([RECIPE_ID, HOUSEHOLD_ID]);

    expect(stub.statements[9]?.kind).toBe("insert");
    expect(stub.statements[9]?.table).toBe("recipe_ingredients");
    expect(stub.statements[10]?.table).toBe("recipe_steps");
  });

  it("leaves original_draft alone — an edit is what 4.6 reverts past", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const recipeUpdate = stub.statements[6];
    expect(recipeUpdate?.table).toBe("recipes");
    expect(recipeUpdate?.values).not.toHaveProperty("originalDraft");
    expectScopedByHousehold(recipeUpdate);
  });

  it("keeps every write inside one transaction", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    for (const statement of stub.statements.slice(1, 3)) {
      expect(statement.txDepth).toBe(0);
    }
    for (const statement of stub.statements.slice(3, 11)) {
      expect(statement.txDepth).toBe(1);
    }
    for (const statement of stub.statements.slice(11)) {
      expect(statement.txDepth).toBe(0);
    }
  });

  it("refuses a product outside the caller's catalog before it locks anything", async () => {
    const { caller, stub } = callerWith([[membershipRow], LOCK_ROW, []]);

    await expect(
      caller.dish.update({
        ...updateInput(),
        draft: draft({
          ingredients: [ingredient({ productId: OTHER_PRODUCT_ID })],
        }),
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    expect(stub.statements).toHaveLength(3);
    expect(stub.statements.every((s) => s.lock === null)).toBe(true);
  });

  it("mints a product for an unbound row and reports it, like create does", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      LOCK_ROW,
      [],
      [categoryRow()],
      LOCK_ROW,
      [{ id: RECIPE_ID }],
      [referenceProductRow()],
      [{ id: DISH_ID }],
      [],
      [],
      [],
      [],
      [],
      ...detailResults(),
    ]);

    const result = await caller.dish.update({
      ...updateInput(),
      draft: draft({ ingredients: [ingredient({ productId: null })] }),
    });

    const productInsert = stub.statements[6];
    expect([productInsert?.kind, productInsert?.table]).toEqual([
      "insert",
      "products",
    ]);
    expect(productInsert?.txDepth).toBe(2);
    expect(stub.statements[11]?.values).toEqual([
      expect.objectContaining({ name: "Мука", productId: NEW_PRODUCT_ID }),
    ]);
    expect(result.createdProducts).toHaveLength(1);
    expect(result.aiFailed).toBe(false);
  });

  it("round-trips a saved dish through draftFromDetail unchanged", async () => {
    // The contract that makes S8.3 one form: what `dish.get` hands the editor
    // is exactly what `dish.update` writes back when nothing was touched.
    const read = callerWith([[membershipRow], ...detailResults()]);
    const detail = await read.caller.dish.get({ id: DISH_ID });

    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update({
      id: DISH_ID,
      expectedVersion: detail.version,
      draft: draftFromDetail(detail),
    });

    expect(stub.statements[5]?.values).toMatchObject({
      title: detail.title,
      tags: detail.tags,
      sourceType: detail.sourceType,
    });
    expect(stub.statements[6]?.values).toMatchObject({
      portionsBase: detail.recipe.portionsBase,
      portionsMin: detail.recipe.portionsMin,
      yieldUnit: detail.recipe.yieldUnit,
      totalTimeMin: detail.recipe.totalTimeMin,
      equipment: detail.recipe.equipment,
    });
    expect(stub.statements[9]?.values).toEqual([
      expect.objectContaining({
        productId: detail.ingredients[0]?.productId,
        rawText: detail.ingredients[0]?.rawText,
        name: detail.ingredients[0]?.name,
        qty: detail.ingredients[0]?.qty,
        unit: detail.ingredients[0]?.unit,
        note: detail.ingredients[0]?.note,
        isOptional: detail.ingredients[0]?.isOptional,
        needsReview: detail.ingredients[0]?.needsReview,
        sortOrder: 0,
      }),
    ]);
    expect(stub.statements[10]?.values).toEqual([
      expect.objectContaining({
        text: detail.steps[0]?.text,
        timerSec: detail.steps[0]?.timerSec,
        timerMaxSec: detail.steps[0]?.timerMaxSec,
        stepOrder: 0,
      }),
    ]);
  });
});

describe("dish.archive", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.dish.archive({ id: DISH_ID, expectedVersion: EXPECTED_VERSION }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("stamps archived_at and bumps the version by one", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID, version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(
      caller.dish.archive({ id: DISH_ID, expectedVersion: EXPECTED_VERSION }),
    ).resolves.toEqual({ id: DISH_ID, version: EXPECTED_VERSION + 1 });

    const values = stub.statements[1]?.values as Record<string, unknown>;
    expect(compile(values.archivedAt)).toContain("now()");
    expect(compile(values.version)).toBe('"dishes"."version" + 1');
  });

  it("guards on the household, the version and the current archive state", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID, version: EXPECTED_VERSION + 1 }],
    ]);

    await caller.dish.archive({
      id: DISH_ID,
      expectedVersion: EXPECTED_VERSION,
    });

    const compiled = compileWithParams(stub.statements[1]?.wheres[0]);
    expect(compiled.sql).toContain('"household_id"');
    expect(compiled.sql).toContain('"archived_at" is null');
    expect(compiled.params).toEqual([DISH_ID, HOUSEHOLD_ID, EXPECTED_VERSION]);
  });

  it("is NOT_FOUND when the dish is not this household's", async () => {
    const { caller } = callerWith([[membershipRow], [], []]);

    await expect(
      caller.dish.archive({
        id: OTHER_DISH_ID,
        expectedVersion: EXPECTED_VERSION,
      }),
    ).rejects.toSatisfy(hasCode("NOT_FOUND"));
  });

  it("is CONFLICT when the dish is there but has moved on", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [],
      [{ id: DISH_ID }],
    ]);

    await expect(
      caller.dish.archive({ id: DISH_ID, expectedVersion: EXPECTED_VERSION }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
    expectScopedByHousehold(stub.statements[2]);
  });

  it("asks nothing extra when the write landed", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID, version: 8 }],
    ]);

    await caller.dish.archive({
      id: DISH_ID,
      expectedVersion: EXPECTED_VERSION,
    });

    expect(stub.statements).toHaveLength(2);
  });
});

describe("dish.unarchive", () => {
  it("clears archived_at and guards on the opposite state", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID, version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(
      caller.dish.unarchive({ id: DISH_ID, expectedVersion: EXPECTED_VERSION }),
    ).resolves.toEqual({ id: DISH_ID, version: EXPECTED_VERSION + 1 });

    const values = stub.statements[1]?.values as Record<string, unknown>;
    expect(values.archivedAt).toBeNull();
    expect(compile(stub.statements[1]?.wheres[0])).toContain(
      '"archived_at" is not null',
    );
  });

  it("is CONFLICT when the row is there but no longer archived", async () => {
    const { caller } = callerWith([[membershipRow], [], [{ id: DISH_ID }]]);

    await expect(
      caller.dish.unarchive({ id: DISH_ID, expectedVersion: EXPECTED_VERSION }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
  });
});

describe("dish.adapt (task 4.6)", () => {
  const PROFILE_ROW = { householdSize: 2, equipment: ["oven"] };
  /** The recipe needs an oven and a mixer; the profile only has the oven. */
  const ADAPT_DETAIL = detailResults([
    detailDishRow({ equipment: ["oven", "mixer"] }),
  ]);

  function adaptInput(overrides: Record<string, unknown> = {}) {
    return {
      dishId: DISH_ID,
      expectedVersion: EXPECTED_VERSION,
      targetPortions: null,
      ...overrides,
    };
  }

  /** A well-formed proposal: one step reworded, one quantity restated. */
  function adaptation(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      summary: "взбиваем венчиком вручную",
      ingredients: [
        {
          index: 0,
          qty: 285,
          unit: "г",
          note: "просеять",
          rawText: null,
        },
      ],
      steps: [
        {
          index: 0,
          text: "Взбить венчиком вручную",
          timerSec: 360,
          timerMaxSec: null,
        },
      ],
      removedStepIndexes: [],
      addedSteps: [],
      ...overrides,
    });
  }

  /** Every read `adapt` makes before the AI call, in order. */
  const ADAPT_READS: StubResult[] = [
    [membershipRow],
    [{ version: EXPECTED_VERSION }],
    ...ADAPT_DETAIL,
    [PROFILE_ROW],
    [{ minute: 0, day: 0 }],
    [{ id: JOB_ID }],
  ];

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.adapt(adaptInput())).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("refuses a stale expectedVersion before spending anything", async () => {
    // `callerWith`'s context hands out `unusableOpenai`, which throws — so
    // reaching the model at all would fail this test loudly. The statement
    // count is the other half: nothing beyond the guard was even read.
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(caller.dish.adapt(adaptInput())).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );

    expect(stub.statements).toHaveLength(2);
    const guard = stub.statements[1];
    expect([guard?.kind, guard?.table]).toEqual(["select", "dishes"]);
    expectScopedByHousehold(guard);
    expect(compileWithParams(guard?.wheres[0]).params).toContain(DISH_ID);
    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
  });

  it("is NOT_FOUND for a dish this household does not have", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.dish.adapt(adaptInput())).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    expect(stub.statements).toHaveLength(2);
  });

  it("reports nothingToAdapt without opening a job when the kitchen covers the recipe", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION }],
      ...detailResults(),
      [PROFILE_ROW],
    ]);

    // `detailResults()` is the plain NYC Cookies row: `equipment: ["oven"]`,
    // which this profile has, and no rescale was asked for.
    await expect(caller.dish.adapt(adaptInput())).resolves.toEqual({
      outcome: "failed",
      jobId: null,
      reason: "nothingToAdapt",
    });

    expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
  });

  it("treats a target equal to the recipe's own yield as no rescale at all", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION }],
      ...detailResults(),
      [PROFILE_ROW],
    ]);

    await expect(
      caller.dish.adapt(adaptInput({ targetPortions: 8 })),
    ).resolves.toMatchObject({ reason: "nothingToAdapt" });
  });

  it("proposes a draft and writes nothing but its ai_jobs rows", async () => {
    const { fake, calls } = fakeOpenai(adaptation());
    const { caller, stub } = aiCallerWith([...ADAPT_READS, []], fake);

    const result = await caller.dish.adapt(adaptInput());

    expect(result).toMatchObject({
      outcome: "proposed",
      jobId: JOB_ID,
      summary: "взбиваем венчиком вручную",
    });

    // THE acceptance criterion: an adaptation is an offer. Everything the
    // procedure touched is either a read or its own ledger row.
    const written = stub.statements.filter((s) => s.kind !== "select");
    expect(written.map((s) => [s.kind, s.table])).toEqual([
      ["insert", "ai_jobs"],
      ["update", "ai_jobs"],
    ]);

    expect(calls[0]?.model).toBe(AI_MODEL);
    expect(calls[0]?.reasoning_effort).toBe("low");
  });

  it("opens the ledger before the call and closes it with the cost right after", async () => {
    const { fake } = fakeOpenai(adaptation());
    const { caller, stub } = aiCallerWith([...ADAPT_READS, []], fake);

    await caller.dish.adapt(adaptInput());

    const opened = stub.statements.find(
      (s) => s.kind === "insert" && s.table === "ai_jobs",
    );
    expect(opened?.values).toMatchObject({
      type: "adapt_recipe",
      status: "running",
      // No `dish_id` column on `ai_jobs`: the dish rides in `input_ref`.
      inputRef: DISH_ID,
      householdId: HOUSEHOLD_ID,
    });

    const closed = stub.statements.find(
      (s) => s.kind === "update" && s.table === "ai_jobs",
    );
    expect(closed?.values).toMatchObject({ status: "done" });
    expect(Number((closed?.values as { costUsd: string }).costUsd)).toBeGreaterThan(0);
    expectScopedByHousehold(closed);
  });

  it("records the cost on the failure branch too, and never throws for it", async () => {
    const { fake } = fakeOpenai("не json");
    const { caller, stub } = aiCallerWith([...ADAPT_READS, []], fake);

    await expect(caller.dish.adapt(adaptInput())).resolves.toEqual({
      outcome: "failed",
      jobId: JOB_ID,
      reason: "aiUnavailable",
    });

    const closed = stub.statements.find(
      (s) => s.kind === "update" && s.table === "ai_jobs",
    );
    expect(closed?.values).toMatchObject({ status: "error" });
    // A response that arrived and then failed validation was still billed.
    expect(Number((closed?.values as { costUsd: string }).costUsd)).toBeGreaterThan(0);
  });

  it("refuses over the rate limit, before the ledger opens", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION }],
      ...ADAPT_DETAIL,
      [PROFILE_ROW],
      [{ minute: 99, day: 99 }],
    ]);

    await expect(caller.dish.adapt(adaptInput())).rejects.toSatisfy(
      hasCode("TOO_MANY_REQUESTS"),
    );
    expect(stub.statements.some((s) => s.table === "ai_jobs" && s.kind === "insert")).toBe(
      false,
    );
  });

  it("scopes the profile read to the household", async () => {
    const { fake } = fakeOpenai(adaptation());
    const { caller, stub } = aiCallerWith([...ADAPT_READS, []], fake);

    await caller.dish.adapt(adaptInput());

    const profile = stub.statements.find((s) => s.table === "kitchen_profiles");
    expectScopedByHousehold(profile);
  });

  it("drops the missing appliance from the proposed recipe", async () => {
    const { fake } = fakeOpenai(adaptation());
    const { caller } = aiCallerWith([...ADAPT_READS, []], fake);

    const result = await caller.dish.adapt(adaptInput());

    // Otherwise S7's banner keeps reporting «Не хватает: Миксер» after the
    // fix has been applied.
    expect(result).toMatchObject({ outcome: "proposed" });
    if (result.outcome !== "proposed") {
      throw new Error("unreachable");
    }
    expect(result.draft.equipment).toEqual(["oven"]);
  });

  it("rescales deterministically and reports every quantity that moved", async () => {
    const { fake, calls } = fakeOpenai(
      JSON.stringify({
        summary: "пересчитано на 4",
        ingredients: [],
        steps: [],
        removedStepIndexes: [],
        addedSteps: [],
      }),
    );
    const { caller } = aiCallerWith([...ADAPT_READS, []], fake);

    const result = await caller.dish.adapt(
      adaptInput({ targetPortions: 4 }),
    );

    if (result.outcome !== "proposed") {
      throw new Error("expected a proposal");
    }
    // 285 г for 8 portions → 142.5 г for 4, by `rescaleQty` and not by the
    // model — which is shown the already-scaled number.
    expect(result.draft.ingredients[0]?.qty).toBe(142.5);
    expect(result.draft.portionsBase).toBe(4);
    expect(result.diff.changedIngredients).toEqual([0]);
    expect(String(calls[0]?.messages[1]?.content)).toContain("142.5");
  });

  describe("a household that never saved a kitchen profile", () => {
    /** No row at all — distinct from a profile that lists no appliances. */
    const NO_PROFILE: StubResult = [];

    it("has nothing to adapt when no rescale was asked for", async () => {
      const { caller, stub } = callerWith([
        [membershipRow],
        [{ version: EXPECTED_VERSION }],
        ...ADAPT_DETAIL,
        NO_PROFILE,
      ]);

      // Nobody said the mixer was absent, so nothing is missing — and the
      // recipe is already stated for the portions asked for.
      await expect(caller.dish.adapt(adaptInput())).resolves.toEqual({
        outcome: "failed",
        jobId: null,
        reason: "nothingToAdapt",
      });
      expect(stub.statements.some((s) => s.table === "ai_jobs")).toBe(false);
    });

    it("rescales without stripping the recipe's own equipment", async () => {
      const { fake, calls } = fakeOpenai(
        JSON.stringify({
          summary: "пересчитано на 4",
          ingredients: [],
          steps: [],
          removedStepIndexes: [],
          addedSteps: [],
        }),
      );
      const { caller } = aiCallerWith(
        [
          [membershipRow],
          [{ version: EXPECTED_VERSION }],
          ...ADAPT_DETAIL,
          NO_PROFILE,
          [{ minute: 0, day: 0 }],
          [{ id: JOB_ID }],
          [],
        ],
        fake,
      );

      const result = await caller.dish.adapt(adaptInput({ targetPortions: 4 }));

      if (result.outcome !== "proposed") {
        throw new Error("expected a proposal");
      }
      // The regression: treating «no profile» as «an empty profile» made every
      // requirement missing, and applying the proposal would have erased both
      // slugs from a recipe nobody complained about.
      expect(result.draft.equipment).toEqual(["oven", "mixer"]);
      expect(String(calls[0]?.messages[1]?.content)).toContain(
        "Про технику на кухне ничего не известно",
      );
    });
  });

  it("drops a proposal index that no longer names a row", async () => {
    const { fake } = fakeOpenai(
      adaptation({
        ingredients: [
          { index: 42, qty: 1, unit: "кг", note: null, rawText: null },
        ],
        steps: [],
      }),
    );
    const { caller } = aiCallerWith([...ADAPT_READS, []], fake);

    const result = await caller.dish.adapt(adaptInput());

    if (result.outcome !== "proposed") {
      throw new Error("expected a proposal");
    }
    expect(result.draft.ingredients[0]?.qty).toBe(285);
    expect(result.diff.changedIngredients).toEqual([]);
  });
});

describe("dish.originalDraft (task 4.6)", () => {
  const ORIGINAL = {
    ...emptyDraft(),
    title: "NYC Cookies",
    sourceType: "photo" as const,
    portionsBase: 8,
    ingredients: [
      {
        rawText: "Мука — 285 г",
        name: "Мука",
        qty: 285,
        unit: "г" as const,
        note: null,
        isOptional: false,
        needsReview: false,
        productId: PRODUCT_ID,
      },
    ],
    steps: [],
  };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.dish.originalDraft({ id: DISH_ID })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is NOT_FOUND for a dish this household does not have", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.dish.originalDraft({ id: DISH_ID })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );

    const read = stub.statements[1];
    expect([read?.kind, read?.table]).toEqual(["select", "recipes"]);
    expectScopedByHousehold(read);
    expect(compileWithParams(read?.wheres[0]).params).toContain(DISH_ID);
  });

  it("returns null for a dish that was never imported", async () => {
    const { caller } = callerWith([[membershipRow], [{ draft: null }]]);

    await expect(caller.dish.originalDraft({ id: DISH_ID })).resolves.toBeNull();
  });

  it("returns the stored draft when every binding still resolves", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ draft: ORIGINAL }],
      [{ id: PRODUCT_ID }],
    ]);

    await expect(caller.dish.originalDraft({ id: DISH_ID })).resolves.toEqual(
      ORIGINAL,
    );
    expectScopedByHousehold(stub.statements[2]);
  });

  it("nulls a binding the household no longer owns instead of rejecting the revert", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [{ draft: ORIGINAL }],
      // The product was deleted since the import.
      [],
    ]);

    const restored = await caller.dish.originalDraft({ id: DISH_ID });

    expect(restored?.ingredients[0]?.productId).toBeNull();
    // Everything else survives: an unbound row is the «новый» state the save
    // path already knows how to resolve.
    expect(restored?.ingredients[0]?.qty).toBe(285);
  });

  it("refuses a stored draft that is no longer a valid recipe", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [{ draft: { title: "", ingredients: "nonsense" } }],
    ]);

    await expect(caller.dish.originalDraft({ id: DISH_ID })).rejects.toSatisfy(
      hasCode("UNPROCESSABLE_CONTENT"),
    );
  });
});

describe("dish.update — the adaptation stamp (task 4.6)", () => {
  const LOCK_ROW: StubResult = [{ version: EXPECTED_VERSION }];
  const PREAMBLE: StubResult[] = [
    [membershipRow],
    LOCK_ROW,
    [{ id: PRODUCT_ID }],
    LOCK_ROW,
    [{ id: RECIPE_ID }],
    [{ id: DISH_ID }],
    [],
    [],
    [],
    [],
    [],
  ];

  function recipeUpdateOf(stub: DbStub) {
    return stub.statements.find(
      (s) => s.kind === "update" && s.table === "recipes",
    );
  }

  function baseInput() {
    return { id: DISH_ID, expectedVersion: EXPECTED_VERSION, draft: draft() };
  }

  it("assigns nothing when the save is an ordinary edit", async () => {
    const { caller, stub } = callerWith([...PREAMBLE, ...detailResults()]);

    await caller.dish.update(baseInput());

    // S8.3's own form never sends the field, and a typo fix must not silently
    // erase «переделано под твою духовку».
    const values = recipeUpdateOf(stub)?.values as Record<string, unknown>;
    expect(Object.hasOwn(values, "adaptedAt")).toBe(false);
    expect(Object.hasOwn(values, "adaptedNote")).toBe(false);
  });

  it("stamps both columns when «Применить» carries a note", async () => {
    const { caller, stub } = callerWith([...PREAMBLE, ...detailResults()]);

    await caller.dish.update({
      ...baseInput(),
      adaptation: { note: "переделано под духовку вместо аэрогриля" },
    });

    const values = recipeUpdateOf(stub)?.values as Record<string, unknown>;
    expect(values.adaptedNote).toBe("переделано под духовку вместо аэрогриля");
    expect(compile(values.adaptedAt)).toContain("now()");
    // Never `dishes.tags` (decision D20) — that is S6's user-facing filter.
    const dishUpdate = stub.statements.find(
      (s) => s.kind === "update" && s.table === "dishes",
    );
    expect((dishUpdate?.values as { tags: string[] }).tags).toEqual(["выпечка"]);
  });

  it("clears both columns when «Вернуть как было» sends null", async () => {
    const { caller, stub } = callerWith([...PREAMBLE, ...detailResults()]);

    await caller.dish.update({ ...baseInput(), adaptation: null });

    expect(recipeUpdateOf(stub)?.values).toMatchObject({
      adaptedAt: null,
      adaptedNote: null,
    });
  });

  it("rejects a note longer than the column's own limit", async () => {
    const { caller } = callerWith([[membershipRow]]);

    await expect(
      caller.dish.update({
        ...baseInput(),
        adaptation: { note: "я".repeat(201) },
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("still refuses a stale version before it stamps anything", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(
      caller.dish.update({ ...baseInput(), adaptation: { note: "адаптировано" } }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
    expect(stub.statements).toHaveLength(2);
  });
});
