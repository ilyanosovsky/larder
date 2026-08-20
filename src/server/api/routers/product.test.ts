import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { AI_LIMIT_PER_DAY, AI_LIMIT_PER_MINUTE } from "@/server/ai/rate-limit";
import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type RecordedStatement,
  type StubResult,
} from "@/server/api/test-support";
import { REFERENCE_PRODUCTS } from "@/server/catalog/reference-products";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";
const OTHER_PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000202";
const AI_JOB_ID = "3f1a6d0e-0000-4000-8000-000000000301";
const PRODUCE_ID = "3f1a6d0e-0000-4000-8000-000000000101";
const DAIRY_ID = "3f1a6d0e-0000-4000-8000-000000000102";
const GROCERY_ID = "3f1a6d0e-0000-4000-8000-000000000105";

const CATEGORY_ROWS = [
  { id: PRODUCE_ID, name: "Овощи и фрукты", sortOrder: 0 },
  { id: DAIRY_ID, name: "Молочное и яйца", sortOrder: 1 },
  { id: GROCERY_ID, name: "Бакалея", sortOrder: 4 },
];

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

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    name: "Молоко",
    icon: "🥛",
    categoryId: DAIRY_ID,
    defaultUnit: "л",
    aliases: [],
    ...overrides,
  };
}

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

/**
 * A stand-in OpenAI client. The context carries `openai` as a factory
 * precisely so a router test can hand one over; the default in
 * `test-support.ts` throws, so a path that reaches OpenAI unexpectedly fails
 * loudly rather than dialing a paid API.
 */
function fakeOpenai(answer: string | Error) {
  const calls: CreateParams[] = [];

  return {
    calls,
    factory: () => ({
      chat: {
        completions: {
          create(params: CreateParams): Promise<Completion> {
            calls.push(params);
            if (answer instanceof Error) {
              return Promise.reject(answer);
            }
            return Promise.resolve({
              id: "chatcmpl-test",
              object: "chat.completion" as const,
              created: 1_787_000_000,
              model: "gpt-5-mini",
              usage: {
                prompt_tokens: 400,
                completion_tokens: 30,
                total_tokens: 430,
              },
              choices: [
                {
                  index: 0,
                  finish_reason: "stop" as const,
                  logprobs: null,
                  message: {
                    role: "assistant" as const,
                    content: answer,
                    refusal: null,
                  },
                },
              ],
            });
          },
        },
      },
    }),
  };
}

function callerWith(
  results: StubResult[],
  openai?: () => ReturnType<ReturnType<typeof fakeOpenai>["factory"]>,
) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db, openai)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

/** Compiles a recorded clause so a test can assert on the real SQL. */
function compile(clause: unknown): string {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL()).sql;
}

/**
 * The tenancy guard (VISION §6.7): a per-row id is never enough on its own.
 * Without compiling the WHERE, a refactor that dropped
 * `eq(products.householdId, …)` would still pass every other test here — the
 * stub's queued rows do not know what the query filtered on.
 */
function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  expect(compile(statement?.wheres[0])).toContain('"household_id"');
}

describe("product.search", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.product.search({ query: "мол" })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.product.search({ query: "мол" })).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("returns nothing, and queries nothing, for an empty query", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(caller.product.search({ query: "  " })).resolves.toEqual([]);
    // Only the householdProcedure membership check ran.
    expect(stub.statements).toHaveLength(1);
  });

  it("rejects an over-long query at the boundary", async () => {
    const { caller } = callerWith([[membershipRow]]);

    await expect(
      caller.product.search({ query: "м".repeat(101) }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("returns the household's own products with their department name", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [productRow()],
      CATEGORY_ROWS,
    ]);

    const hits = await caller.product.search({ query: "мол" });

    expect(hits[0]).toEqual({
      source: "catalog",
      productId: PRODUCT_ID,
      name: "Молоко",
      icon: "🥛",
      categoryId: DAIRY_ID,
      categoryName: "Молочное и яйца",
      unit: "л",
    });
    // The built-in «Молоко» is gone — the household already owns that name,
    // and two rows for one product is the duplicate this design prevents.
    expect(hits.filter((hit) => hit.name === "Молоко")).toHaveLength(1);
  });

  it("tops the list up with reference entries, resolved onto real departments", async () => {
    const { caller } = callerWith([[membershipRow], [], CATEGORY_ROWS]);

    const hits = await caller.product.search({ query: "пом" });

    expect(hits[0]).toMatchObject({
      source: "reference",
      productId: null,
      name: "Помидоры",
      categoryId: PRODUCE_ID,
      categoryName: "Овощи и фрукты",
    });
  });

  it("scopes both reads to the caller's own household", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [productRow()],
      CATEGORY_ROWS,
    ]);

    await caller.product.search({ query: "мол" });

    expect(stub.statements[1]).toMatchObject({
      kind: "select",
      table: "products",
    });
    expectScopedByHousehold(stub.statements[1]);
    expect(stub.statements[2]).toMatchObject({
      kind: "select",
      table: "categories",
    });
    expectScopedByHousehold(stub.statements[2]);
  });
});

describe("product.list", () => {
  it("returns the catalog with its department columns", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          ...productRow(),
          categoryName: "Молочное и яйца",
          categoryIcon: "🥛",
          categorySortOrder: 1,
        },
      ],
    ]);

    await expect(caller.product.list()).resolves.toEqual([
      {
        id: PRODUCT_ID,
        name: "Молоко",
        icon: "🥛",
        categoryId: DAIRY_ID,
        defaultUnit: "л",
        aliases: [],
        categoryName: "Молочное и яйца",
        categoryIcon: "🥛",
        categorySortOrder: 1,
      },
    ]);
  });

  it("orders by department, then by name", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.product.list();

    const select = stub.statements[1];
    expectScopedByHousehold(select);
    expect(compile(select?.orderBys[0])).toContain('"sort_order"');
    expect(compile(select?.orderBys[1])).toContain('"name"');
  });
});

describe("product.create — an existing product", () => {
  it("returns the row it already has instead of a second one", async () => {
    // household check → categories → existing lookup
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [productRow()],
    ]);

    await expect(
      caller.product.create({ source: "new", name: "молоко" }),
    ).resolves.toEqual({
      product: {
        id: PRODUCT_ID,
        name: "Молоко",
        icon: "🥛",
        categoryId: DAIRY_ID,
        defaultUnit: "л",
        aliases: [],
      },
      enriched: false,
      aiFailed: false,
    });
    // Nothing was inserted, and — the point — no AI call was made: the
    // context's `openai` would have thrown.
    expect(stub.statements).toHaveLength(3);
  });

  it("matches an existing product on lower(name) or an alias", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [productRow()],
    ]);

    await caller.product.create({ source: "reference", name: "Молоко" });

    const lookup = stub.statements[2];
    expectScopedByHousehold(lookup);
    const where = compile(lookup?.wheres[0]);
    expect(where).toContain("lower(");
    expect(where).toContain("ANY(");
  });
});

describe("product.create — the reference path", () => {
  const reference = REFERENCE_PRODUCTS.find(
    (entry) => entry.name === "Помидоры",
  )!;

  it("re-resolves icon, department and unit on the server", async () => {
    // household → categories → existing lookup (none) → insert
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [productRow({ name: "Помидоры", icon: "🍅", categoryId: PRODUCE_ID })],
    ]);

    await caller.product.create({ source: "reference", name: "помидор" });

    const insert = stub.statements[3];
    expect(insert).toMatchObject({ kind: "insert", table: "products" });
    expect(insert?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      // The reference entry's own capitalization, not the query's.
      name: "Помидоры",
      icon: reference.icon,
      defaultUnit: reference.unit,
      categoryId: PRODUCE_ID,
      aliases: [...reference.aliases],
      createdBy: "user_1",
    });
  });

  it("reports the product as not AI-enriched", async () => {
    const { caller } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [productRow({ name: "Помидоры", icon: "🍅", categoryId: PRODUCE_ID })],
    ]);

    await expect(
      caller.product.create({ source: "reference", name: "Помидоры" }),
    ).resolves.toMatchObject({ enriched: false, aiFailed: false });
  });

  it("refuses a name that is not in the reference catalog", async () => {
    // The client sends only a name, and the server owns the resolution — a
    // forged "reference" create cannot smuggle in its own icon or department.
    const { caller } = callerWith([[membershipRow], CATEGORY_ROWS, []]);

    await expect(
      caller.product.create({ source: "reference", name: "Буррата" }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("returns the winner's row when a concurrent insert wins the race", async () => {
    // household → categories → lookup (none) → insert throws 23505 → re-read
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      cause: { code: "23505" },
    });
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      uniqueViolation,
      [productRow({ name: "Помидоры", icon: "🍅", categoryId: PRODUCE_ID })],
    ]);

    await expect(
      caller.product.create({ source: "reference", name: "Помидоры" }),
    ).resolves.toMatchObject({ product: { name: "Помидоры" } });
    expect(stub.statements[4]).toMatchObject({
      kind: "select",
      table: "products",
    });
  });
});

describe("product.create — the AI path", () => {
  const answer = JSON.stringify({
    icon: "🧀",
    categoryId: DAIRY_ID,
    unit: "уп",
  });

  /** household → categories → lookup (none) → rate-limit counts → job insert */
  function preamble(minute = 0, day = 0): StubResult[] {
    return [
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [{ minute, day }],
      [{ id: AI_JOB_ID }],
    ];
  }

  it("creates the product with what the AI picked", async () => {
    const openai = fakeOpenai(answer);
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [], // ai_jobs update
        [productRow({ name: "Буррата", icon: "🧀", categoryId: DAIRY_ID })],
      ],
      openai.factory,
    );

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).resolves.toMatchObject({ enriched: true, aiFailed: false });

    expect(openai.calls).toHaveLength(1);
    expect(stub.statements[6]?.values).toMatchObject({
      name: "Буррата",
      icon: "🧀",
      categoryId: DAIRY_ID,
      defaultUnit: "уп",
    });
  });

  it("records the job as running before the call and done after it", async () => {
    const openai = fakeOpenai(answer);
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🧀", categoryId: DAIRY_ID })],
      ],
      openai.factory,
    );

    await caller.product.create({ source: "new", name: "Буррата" });

    // The job row exists before the call, which is what makes the rate
    // limiter count in-flight requests.
    expect(stub.statements[4]).toMatchObject({
      kind: "insert",
      table: "ai_jobs",
      values: {
        householdId: HOUSEHOLD_ID,
        userId: "user_1",
        type: "product_enrich",
        status: "running",
        inputRef: "Буррата",
      },
    });
    expect(stub.statements[5]).toMatchObject({
      kind: "update",
      table: "ai_jobs",
      values: {
        status: "done",
        outputJson: { icon: "🧀", categoryId: DAIRY_ID, unit: "уп" },
      },
    });
  });

  it("writes the cost of every call into the ledger", async () => {
    const openai = fakeOpenai(answer);
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🧀", categoryId: DAIRY_ID })],
      ],
      openai.factory,
    );

    await caller.product.create({ source: "new", name: "Буррата" });

    // 400 prompt + 30 completion at the gpt-5-mini rates, as the six-decimal
    // string `numeric(10, 6)` takes.
    expect(stub.statements[5]?.values).toMatchObject({
      costUsd: "0.000160",
    });
  });

  it("still creates the product when the AI call fails", async () => {
    // VISION §3.1: ИИ — помощник, всё редактируемо. Someone who typed
    // «буррата» wants a product, not an apology.
    const openai = fakeOpenai(new Error("connect ETIMEDOUT"));
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🛒", categoryId: GROCERY_ID })],
      ],
      openai.factory,
    );

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).resolves.toMatchObject({ enriched: false, aiFailed: true });

    expect(stub.statements[6]?.values).toMatchObject({
      name: "Буррата",
      icon: "🛒",
      // «Бакалея», the shared fallback department.
      categoryId: GROCERY_ID,
      defaultUnit: "шт",
    });
  });

  it("records the failed job with its error", async () => {
    const openai = fakeOpenai(new Error("connect ETIMEDOUT"));
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🛒", categoryId: GROCERY_ID })],
      ],
      openai.factory,
    );

    await caller.product.create({ source: "new", name: "Буррата" });

    expect(stub.statements[5]).toMatchObject({
      kind: "update",
      table: "ai_jobs",
      values: { status: "error", error: "connect ETIMEDOUT" },
    });
  });

  it("falls back when the AI answers with a department it was not offered", async () => {
    const openai = fakeOpenai(
      JSON.stringify({ icon: "🧀", categoryId: "cat-invented", unit: "уп" }),
    );
    const { caller, stub } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🛒", categoryId: GROCERY_ID })],
      ],
      openai.factory,
    );

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).resolves.toMatchObject({ aiFailed: true });

    // Billed even though the answer was unusable — the ledger must not
    // under-report exactly when things go wrong.
    expect(stub.statements[5]?.values).toMatchObject({
      status: "error",
      costUsd: "0.000160",
    });
  });

  it("degrades gracefully when the client cannot even be built", async () => {
    // A missing OPENAI_API_KEY must not turn «Создать» into a 500.
    const { caller } = callerWith(
      [
        ...preamble(),
        [],
        [productRow({ name: "Буррата", icon: "🛒", categoryId: GROCERY_ID })],
      ],
      () => {
        throw new Error("OPENAI_API_KEY missing");
      },
    );

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).resolves.toMatchObject({ aiFailed: true });
  });
});

describe("product.create — rate limiting", () => {
  it("refuses once the per-minute allowance is spent", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [{ minute: AI_LIMIT_PER_MINUTE, day: AI_LIMIT_PER_MINUTE }],
    ]);

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));
    // No job row, no AI call, no product.
    expect(stub.statements).toHaveLength(4);
  });

  it("refuses once the daily allowance is spent", async () => {
    const { caller } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [{ minute: 0, day: AI_LIMIT_PER_DAY }],
    ]);

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));
  });

  it("counts only this user's own recent jobs", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [{ minute: AI_LIMIT_PER_MINUTE, day: AI_LIMIT_PER_MINUTE }],
    ]);

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));

    const counts = stub.statements[3];
    expect(counts).toMatchObject({ kind: "select", table: "ai_jobs" });
    const where = compile(counts?.wheres[0]);
    expect(where).toContain('"user_id"');
    expect(where).toContain('"created_at"');
  });

  it("binds the window boundaries through their column's own encoder", async () => {
    // A `Date` interpolated straight into a raw `sql` fragment is bound with
    // no column type, and postgres.js throws at bind time ("Received an
    // instance of Date") — a failure no queued stub row can reproduce, since
    // the stub never speaks to a database. Compiling the projection and
    // checking that every parameter came out already encoded is what catches
    // a regression back to the raw form.
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [{ minute: AI_LIMIT_PER_MINUTE, day: AI_LIMIT_PER_MINUTE }],
    ]);

    await expect(
      caller.product.create({ source: "new", name: "Буррата" }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));

    const fields = stub.statements[3]?.fields as Record<string, SQLWrapper>;
    for (const clause of [
      ...Object.values(fields),
      stub.statements[3]?.wheres[0] as SQLWrapper,
    ]) {
      const { params } = new PgDialect().sqlToQuery(clause.getSQL());
      for (const param of params) {
        expect(param).not.toBeInstanceOf(Date);
      }
    }
  });

  it("does not rate-limit the free reference path", async () => {
    // Picking a known product costs nothing and must keep working even for
    // someone who just exhausted their AI allowance.
    const { caller, stub } = callerWith([
      [membershipRow],
      CATEGORY_ROWS,
      [],
      [productRow({ name: "Помидоры", icon: "🍅", categoryId: PRODUCE_ID })],
    ]);

    await expect(
      caller.product.create({ source: "reference", name: "Помидоры" }),
    ).resolves.toMatchObject({ enriched: false });
    // household → categories → lookup → insert. No ai_jobs count.
    expect(stub.statements).toHaveLength(4);
  });
});

describe("product.update", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.product.update({ id: PRODUCT_ID, icon: "🧀" }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("rejects an empty patch before touching the database", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(caller.product.update({ id: PRODUCT_ID })).rejects.toSatisfy(
      hasCode("BAD_REQUEST"),
    );
    expect(stub.statements).toHaveLength(1);
  });

  it("applies the fields it was given", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [productRow({ icon: "🧀", name: "Буррата" })],
    ]);

    await caller.product.update({
      id: PRODUCT_ID,
      name: "Буррата",
      icon: "🧀",
      defaultUnit: "уп",
    });

    expect(stub.statements[1]).toMatchObject({
      kind: "update",
      table: "products",
      values: { name: "Буррата", icon: "🧀", defaultUnit: "уп" },
    });
  });

  it("scopes the update to the caller's own household", async () => {
    const { caller, stub } = callerWith([[membershipRow], [productRow()]]);

    await caller.product.update({ id: PRODUCT_ID, icon: "🧀" });

    expectScopedByHousehold(stub.statements[1]);
    expect(compile(stub.statements[1]?.wheres[0])).toContain('"id"');
  });

  it("checks a new department belongs to the caller's household", async () => {
    // Unchecked, a foreign category id would happily satisfy the foreign key
    // and file the product under someone else's department.
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(
      caller.product.update({ id: PRODUCT_ID, categoryId: DAIRY_ID }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    const check = stub.statements[1];
    expect(check).toMatchObject({ kind: "select", table: "categories" });
    expectScopedByHousehold(check);
    // The update never ran.
    expect(stub.statements).toHaveLength(2);
  });

  it("accepts a department the household owns", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [{ id: DAIRY_ID }],
      [productRow({ categoryId: DAIRY_ID })],
    ]);

    await expect(
      caller.product.update({ id: PRODUCT_ID, categoryId: DAIRY_ID }),
    ).resolves.toMatchObject({ categoryId: DAIRY_ID });
  });

  it("is NOT_FOUND when no row of this household matched", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(
      caller.product.update({ id: OTHER_PRODUCT_ID, icon: "🧀" }),
    ).rejects.toSatisfy(hasCode("NOT_FOUND"));
  });

  it("turns a name collision into CONFLICT rather than a 500", async () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      cause: { code: "23505" },
    });
    const { caller } = callerWith([[membershipRow], uniqueViolation]);

    await expect(
      caller.product.update({ id: PRODUCT_ID, name: "Помидоры" }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
  });
});
