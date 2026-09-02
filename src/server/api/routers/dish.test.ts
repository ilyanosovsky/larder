import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { emptyDraft, type RecipeDraft } from "@/lib/recipes/draft";
import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
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
const JOB_ID = "3f1a6d0e-0000-4000-8000-000000000701";

/** A version nobody could reach by accident — so a test proves it was bound. */
const EXPECTED_VERSION = 7;

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
    productId: null,
    ...overrides,
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
 */
function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  expect(compile(statement?.wheres[0])).toContain('"household_id"');
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
    expect(compile(fields.ingredientCount)).toContain("count(");
    expect(compile(fields.needsReviewCount)).toContain("filter (where");
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
  const CREATE_PREAMBLE: StubResult[] = [
    [membershipRow],
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

    expect(stub.statements.slice(1, 5).map((s) => [s.kind, s.table])).toEqual([
      ["insert", "dishes"],
      ["insert", "recipes"],
      ["insert", "recipe_ingredients"],
      ["insert", "recipe_steps"],
    ]);
    for (const statement of stub.statements.slice(1, 5)) {
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

    expect(stub.statements[1]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      createdBy: "user_1",
      title: "NYC Cookies",
      normalizedTitle: "nyc cookies",
      sourceType: "photo",
    });
    expect(stub.statements[2]?.values).toMatchObject({
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

    expect(stub.statements[2]?.values).toMatchObject({
      originalDraft: { title: "NYC Cookies (импорт)" },
    });

    const manual = callerWith([...CREATE_PREAMBLE, ...detailResults()]);
    await manual.caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });
    expect(manual.stub.statements[2]?.values).toMatchObject({
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

    expect(stub.statements[3]?.values).toEqual([
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
    expect(stub.statements[4]?.values).toEqual([
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
      [membershipRow],
      [{ id: PRODUCT_ID }],
      [{ id: DISH_ID }],
      [{ id: RECIPE_ID }],
      [],
      [],
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft({ ingredients: [ingredient({ productId: PRODUCT_ID })] }),
      originalDraft: null,
      jobId: null,
    });

    const check = stub.statements[1];
    expect(check?.table).toBe("products");
    // Outside the transaction: from task 4.2 this is where a 15–40 s
    // enrichment call runs, and it must not hold row locks open.
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

  it("skips the catalog check when every row is unbound", async () => {
    const { caller, stub } = callerWith([
      ...CREATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.create({
      draft: draft(),
      originalDraft: null,
      jobId: null,
    });

    expect(stub.statements[1]?.table).toBe("dishes");
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

    const job = stub.statements[5];
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
    // Task 4.2 fills these; 4.1 saves unbound rows as the honest «новый».
    expect(result.createdProducts).toEqual([]);
    expect(result.aiFailed).toBe(false);
    for (const statement of stub.statements.slice(5)) {
      expect(statement.txDepth).toBe(0);
    }
  });
});

describe("dish.update", () => {
  const LOCK_ROW: StubResult = [{ version: EXPECTED_VERSION }];
  const UPDATE_PREAMBLE: StubResult[] = [
    [membershipRow],
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

  it("locks the dish row before it reads its version", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const lock = stub.statements[1];
    expect(lock?.table).toBe("dishes");
    expect(lock?.lock).toEqual({ strength: "update", config: undefined });
    expect(lock?.txDepth).toBe(1);
    expectScopedByHousehold(lock);
  });

  it("is NOT_FOUND for a dish this household does not have", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });

  it("is CONFLICT when the dish moved on since the editor opened it", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ version: EXPECTED_VERSION + 1 }],
    ]);

    await expect(caller.dish.update(updateInput())).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
    // Refused on the read; nothing was written.
    expect(stub.statements.every((s) => s.kind === "select")).toBe(true);
  });

  it("bumps the version by exactly one", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const values = stub.statements[3]?.values as Record<string, unknown>;
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

    const compiled = compileWithParams(stub.statements[3]?.wheres[0]);
    expect(compiled.sql).toContain('"version"');
    expect(compiled.params).toEqual([DISH_ID, HOUSEHOLD_ID, EXPECTED_VERSION]);

    // A different token must actually reach the statement — a hardcoded
    // constant would pass the assertion above by coincidence.
    const other = callerWith([
      [membershipRow],
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
    expect(compileWithParams(other.stub.statements[3]?.wheres[0]).params).toEqual(
      [DISH_ID, HOUSEHOLD_ID, 42],
    );
  });

  it("is CONFLICT when the guarded write matches nothing", async () => {
    const { caller } = callerWith([
      [membershipRow],
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
      stub.statements[5],
      stub.statements[6],
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

    expect(stub.statements[7]?.kind).toBe("insert");
    expect(stub.statements[7]?.table).toBe("recipe_ingredients");
    expect(stub.statements[8]?.table).toBe("recipe_steps");
  });

  it("leaves original_draft alone — an edit is what 4.6 reverts past", async () => {
    const { caller, stub } = callerWith([
      ...UPDATE_PREAMBLE,
      ...detailResults(),
    ]);

    await caller.dish.update(updateInput());

    const recipeUpdate = stub.statements[4];
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

    for (const statement of stub.statements.slice(1, 9)) {
      expect(statement.txDepth).toBe(1);
    }
    for (const statement of stub.statements.slice(9)) {
      expect(statement.txDepth).toBe(0);
    }
  });

  it("refuses a product outside the caller's catalog before it locks anything", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(
      caller.dish.update({
        ...updateInput(),
        draft: draft({
          ingredients: [ingredient({ productId: OTHER_PRODUCT_ID })],
        }),
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    expect(stub.statements).toHaveLength(2);
    expect(stub.statements.every((s) => s.lock === null)).toBe(true);
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
