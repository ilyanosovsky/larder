import { readFileSync } from "node:fs";

import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiRequestOptions } from "@/server/ai/openai";
import type { ParsedRecipe } from "@/server/ai/parse-recipe";
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

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const JOB_ID = "3f1a6d0e-0000-4000-8000-000000000501";
const DISH_ID = "3f1a6d0e-0000-4000-8000-000000000601";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";
const CATEGORY_ID = "3f1a6d0e-0000-4000-8000-000000000102";
const FILE_KEY = "aBcD1234_-key";
const APP_ID = "app1";
/** What the router must rebuild from the key alone (decision D5). */
const PHOTO_URL = `https://${APP_ID}.ufs.sh/f/${FILE_KEY}`;
/**
 * What UploadThing returned at upload time and `photo_uploads.url` stores —
 * the thumbnail the draft carries.
 *
 * **Deliberately a different host from `PHOTO_URL`.** UploadThing has served
 * both, and in production the two coincide, which is exactly why they must not
 * coincide here: while they were the same string, the suite's only assertion
 * on D5 could not fail, and passing the stored column straight to OpenAI
 * instead of rebuilding kept all 1364 tests green.
 */
const STORED_URL = `https://utfs.io/f/${FILE_KEY}`;

/**
 * `fromPhoto` rebuilds the image URL from the app id inside the token, so the
 * suite needs one — synthetic, never a real project's.
 */
beforeEach(() => {
  // Empty rather than unstubbed: on a machine that exports a real key, a test
  // that forgot to set one would otherwise run against it. The FireCrawl
  // tests below stub a synthetic value over this.
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  vi.stubEnv(
    "UPLOADTHING_TOKEN",
    Buffer.from(
      JSON.stringify({ apiKey: "sk_test", appId: APP_ID, regions: ["sea1"] }),
      "utf8",
    ).toString("base64"),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

const RECIPE: ParsedRecipe = {
  isRecipe: true,
  title: "NYC Cookies",
  portionsBase: 8,
  portionsMin: 7,
  yieldUnit: "печений",
  totalTimeMin: 30,
  equipment: ["духовка"],
  tags: ["десерт"],
  ingredients: [
    {
      rawText: "Мука — 285 г",
      name: "Мука",
      qty: 285,
      unit: "г",
      note: null,
      isOptional: false,
    },
  ],
  steps: [{ text: "Выпекать", timerSec: 540, timerMaxSec: 660 }],
};

/**
 * A stand-in OpenAI client that also records the **per-request options**: the
 * import's 40 s timeout and its refusal to retry are as much part of the
 * contract as the prompt, and neither is visible in the request body.
 */
function fakeOpenai(answer: string | Error) {
  const calls: {
    params: CreateParams;
    options: AiRequestOptions | undefined;
  }[] = [];

  return {
    calls,
    factory: () => ({
      chat: {
        completions: {
          create(
            params: CreateParams,
            options?: AiRequestOptions,
          ): Promise<Completion> {
            calls.push({ params, options });
            if (answer instanceof Error) {
              return Promise.reject(answer);
            }
            return Promise.resolve({
              id: "chatcmpl-test",
              object: "chat.completion" as const,
              created: 1_787_000_000,
              model: "gpt-5-mini",
              usage: {
                prompt_tokens: 1_600,
                completion_tokens: 900,
                total_tokens: 2_500,
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

/**
 * A recording stand-in for the blob store.
 *
 * The deletion used to be an unreachable branch: the `discardPhoto` describe
 * ran with no `UPLOADTHING_TOKEN`, so the real store returned at its token
 * guard — and *removing the call entirely*, or hoisting it above the "a saved
 * dish is using this key" guard so «Отмена» deletes a photo a dish renders,
 * both left all 32 tests green.
 */
function fakeUploadThing(stub: DbStub) {
  /**
   * `at` is how many statements had run when the delete was issued, which is
   * what makes the ordering assertable: «revoke the row, then the blob» is
   * declared load-bearing by both the router's comment and the test's, yet
   * hoisting `deleteFiles` above the DELETE used to leave the whole repo
   * green — the fake recorded keys and nothing else.
   */
  const deleted: { keys: string[]; at: number }[] = [];

  return {
    deleted,
    factory: () => ({
      deleteFiles(fileKeys: readonly string[]) {
        deleted.push({ keys: [...fileKeys], at: stub.statements.length });
        return Promise.resolve();
      },
    }),
  };
}

/** `callerWith`, plus the injected blob store `discardPhoto` needs. */
function discardCallerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  const uploadThing = fakeUploadThing(stub);

  return {
    caller: createCaller(
      signedInContext(stub.db, undefined, uploadThing.factory),
    ),
    stub,
    uploadThing,
  };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

function compileWithParams(clause: unknown): {
  sql: string;
  params: unknown[];
} {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL());
}

/**
 * A local helper, mirroring `pantry.test.ts:82` — deliberately not shared
 * through `test-support.ts`, so each router test keeps stating its own
 * tenancy expectation rather than inheriting one.
 */
function expectScopedByHousehold(
  statement: RecordedStatement | undefined,
  householdId: string = HOUSEHOLD_ID,
) {
  const compiled = compileWithParams(statement?.wheres[0]);
  expect(compiled.sql).toContain('"household_id"');
  expect(compiled.params).toContain(householdId);
}

/**
 * The `ai_jobs` half of the guard, which `expectScopedByHousehold` cannot see:
 * it compiles `wheres[0]` and stops at the household column, so deleting
 * `eq(aiJobs.id, …)` from all four ledger statements left the entire suite
 * green — a regression that would widen those writes to every job in the
 * household.
 */
function expectScopedByJob(
  statement: RecordedStatement | undefined,
  jobId: string = JOB_ID,
) {
  const compiled = compileWithParams(statement?.wheres[0]);
  expect(compiled.sql).toContain('"ai_jobs"."id"');
  expect(compiled.params).toContain(jobId);
  expect(compiled.params).toContain(HOUSEHOLD_ID);
}

const photoRow = [{ url: STORED_URL }];
const rateLimitOk = [{ minute: 0, day: 0 }];
const jobRow = [{ id: JOB_ID }];

/**
 * household check → the `photo_uploads` ownership read → the rate-limit count
 * → the `ai_jobs` INSERT … RETURNING.
 */
function fromPhotoPreamble(): StubResult[] {
  return [[membershipRow], photoRow, rateLimitOk, jobRow];
}

describe("dishImport.fromPhoto — the gate", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.dishImport.fromPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(
      caller.dishImport.fromPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it.each([
    ["a traversal", "../../etc/passwd"],
    ["a full URL", "https://evil.example.com/f/key"],
    ["a query string", "key?x=1"],
    ["an empty key", ""],
  ])("refuses %s before it reaches any data", async (_label, fileKey) => {
    // The regex lives on the input schema, so a key-shaped-ish string is
    // refused at validation — after `householdProcedure`'s own membership
    // lookup (tRPC runs middlewares before input parsing) and before every
    // read that touches recipe data, and certainly before any network.
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(caller.dishImport.fromPhoto({ fileKey })).rejects.toSatisfy(
      hasCode("BAD_REQUEST"),
    );
    expect(stub.statements).toHaveLength(1);
    expect(stub.statements[0]?.table).toBe("household_members");
  });

  it("refuses a key belonging to another household, before any AI call", async () => {
    // `unusableOpenai` is the context default, so reaching OpenAI here would
    // throw a different error entirely — which is the point.
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(
      caller.dishImport.fromPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("FORBIDDEN"));

    // The ownership read, and nothing after it: no rate-limit count, no job.
    expect(stub.statements).toHaveLength(2);
    expect(stub.statements[1]?.table).toBe("photo_uploads");
    expectScopedByHousehold(stub.statements[1]);
    expect(compileWithParams(stub.statements[1]?.wheres[0]).params).toContain(
      FILE_KEY,
    );
  });

  it("refuses when the user is over the AI rate limit", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      photoRow,
      [{ minute: 10, day: 12 }],
    ]);

    await expect(
      caller.dishImport.fromPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));

    // Nothing was opened in the ledger for a call that never happened.
    expect(
      stub.statements.some((statement) => statement.kind === "insert"),
    ).toBe(false);
  });
});

describe("dishImport.fromPhoto — the ledger", () => {
  it("opens the job row before the model is called", async () => {
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller, stub } = callerWith(
      [
        ...fromPhotoPreamble(),
        [],
        [],
        [{ id: CATEGORY_ID, name: "Бакалея", sortOrder: 0 }],
        [],
      ],
      openai.factory,
    );

    await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    const insert = stub.statements.find(
      (statement) => statement.kind === "insert",
    );
    expect(insert?.table).toBe("ai_jobs");
    expect(insert?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      userId: "user_1",
      type: "parse_photo",
      status: "running",
      // The rate limiter counts `ai_jobs` rows, so a call still in flight has
      // to already count against the window.
      inputRef: FILE_KEY,
    });

    // Written before the request went out: the insert is recorded ahead of
    // every statement that follows the model's answer.
    expect(stub.statements.indexOf(insert!)).toBeLessThan(
      stub.statements.findIndex(
        (statement) =>
          statement.kind === "update" && statement.table === "ai_jobs",
      ),
    );
    expect(openai.calls).toHaveLength(1);
  });

  it("stamps a cost on the failure branch too", async () => {
    // A response that came back and then failed validation was still billed;
    // a ledger that counts only successes under-reports exactly when things
    // go wrong.
    const openai = fakeOpenai("{ not json");
    const { caller, stub } = callerWith(
      [...fromPhotoPreamble(), [], []],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(result.outcome).toBe("failed");

    const ledger = stub.statements.find(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    const values = ledger?.values as Record<string, unknown>;
    expect(values.status).toBe("error");
    expect(values.costUsd).toBeTypeOf("string");
    expect(Number(values.costUsd)).toBeGreaterThan(0);
    expectScopedByHousehold(ledger);
    expectScopedByJob(ledger);
  });

  it("records no cost when the request itself never completed", async () => {
    const openai = fakeOpenai(new Error("connect ETIMEDOUT"));
    const { caller, stub } = callerWith(
      [...fromPhotoPreamble(), [], []],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "aiUnavailable",
    });

    const ledger = stub.statements.find(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    expect((ledger?.values as Record<string, unknown>).costUsd).toBe(
      "0.000000",
    );
  });

  it("still stamps the cost when a later step throws", async () => {
    // The catalog read happens *after* the model answered. If it were inside
    // the same try as the ledger write, a database hiccup here would lose the
    // record of a call the household was already billed for (decision C.2).
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller, stub } = callerWith(
      [
        ...fromPhotoPreamble(),
        [], // the ledger UPDATE
        new Error("catalog read failed"),
        [], // markJobError's UPDATE
      ],
      openai.factory,
    );

    await expect(
      caller.dishImport.fromPhoto({ fileKey: FILE_KEY }),
    ).rejects.toThrow(/catalog read failed/);

    const ledgerUpdates = stub.statements.filter(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    const cost = (ledgerUpdates[0]?.values as Record<string, unknown>).costUsd;
    expect(Number(cost)).toBeGreaterThan(0);
    // And the failure itself is visible in the ledger rather than a row that
    // says «done» beside an import nobody received.
    expect((ledgerUpdates[1]?.values as Record<string, unknown>).status).toBe(
      "error",
    );
    expectScopedByJob(ledgerUpdates[0]);
    expectScopedByJob(ledgerUpdates[1]);
  });
});

describe("dishImport.fromPhoto — the request", () => {
  it("sends the image at detail:high, at low reasoning effort, with no retry", async () => {
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller } = callerWith(
      [...fromPhotoPreamble(), [], [], [], []],
      openai.factory,
    );

    await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    const call = openai.calls[0];
    expect(call?.params.reasoning_effort).toBe("low");
    expect(call?.params.messages[1]?.content).toEqual([
      { type: "text", text: expect.any(String) },
      {
        type: "image_url",
        // Rebuilt server-side from the key — the client never supplies a URL.
        image_url: { url: PHOTO_URL, detail: "high" },
      },
    ]);
    expect(call?.options).toMatchObject({ timeout: 40_000, maxRetries: 0 });
    expect(call?.options?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("dishImport.fromPhoto — the outcome", () => {
  it("returns a draft and stores it on the job row", async () => {
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller, stub } = callerWith(
      [
        ...fromPhotoPreamble(),
        [], // ledger
        [], // products
        [{ id: CATEGORY_ID, name: "Бакалея", sortOrder: 0 }],
        [], // output_json
      ],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(result).toMatchObject({
      outcome: "parsed",
      jobId: JOB_ID,
      via: "vision",
      consumedDishId: null,
    });
    expect(result.outcome === "parsed" && result.draft).toMatchObject({
      title: "NYC Cookies",
      sourceType: "photo",
      photoKey: FILE_KEY,
      photoUrl: STORED_URL,
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "печений",
    });

    // The ledger's *success* branch. Nothing else in the suite asserted it,
    // so flipping «done» to «running» here left all 1364 tests green while
    // corrupting every spend and ops report built on `ai_jobs.status`.
    const ledger = stub.statements.find(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    expect(ledger?.values).toMatchObject({
      status: "done",
      finishedAt: expect.anything(),
    });
    expectScopedByJob(ledger);

    // The draft is written into `output_json` by a *second*, small update, so
    // a reload can re-render the identical form.
    const stored = stub.statements.at(-1);
    expect(stored?.table).toBe("ai_jobs");
    expect(
      (stored?.values as Record<string, unknown>).outputJson,
    ).toMatchObject({ outcome: "parsed" });
    expectScopedByHousehold(stored);
    expectScopedByJob(stored);
  });

  it("binds an ingredient the household already owns", async () => {
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller } = callerWith(
      [
        ...fromPhotoPreamble(),
        [],
        [
          {
            id: PRODUCT_ID,
            name: "Мука",
            icon: "🌾",
            categoryId: CATEGORY_ID,
            defaultUnit: "кг",
            aliases: [],
          },
        ],
        [{ id: CATEGORY_ID, name: "Бакалея", sortOrder: 0 }],
        [],
      ],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(
      result.outcome === "parsed" && result.draft.ingredients[0]?.productId,
    ).toBe(PRODUCT_ID);
  });

  it("reports «not a recipe» as an outcome, never as a thrown error", async () => {
    // Throwing would collapse nine outcomes into one red box and lose the
    // jobId — and with it the cost record and the retry handle.
    const openai = fakeOpenai(
      JSON.stringify({
        ...RECIPE,
        isRecipe: false,
        ingredients: [],
        steps: [],
      }),
    );
    const { caller } = callerWith(
      [...fromPhotoPreamble(), [], [], [], []],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(result).toEqual({
      outcome: "failed",
      jobId: JOB_ID,
      reason: "notARecipe",
      consumedDishId: null,
      partial: {
        title: "NYC Cookies",
        photoUrl: STORED_URL,
        photoKey: FILE_KEY,
        sourceUrl: null,
      },
    });
  });

  it("hands the failed outcome the photo it already has, for «вручную»", async () => {
    const openai = fakeOpenai(new Error("connect ETIMEDOUT"));
    const { caller } = callerWith(
      [...fromPhotoPreamble(), [], []],
      openai.factory,
    );

    const result = await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    expect(result.outcome === "failed" && result.partial).toEqual({
      title: null,
      photoUrl: STORED_URL,
      photoKey: FILE_KEY,
      sourceUrl: null,
    });
  });

  it("scopes every statement it issues by household", async () => {
    const openai = fakeOpenai(JSON.stringify(RECIPE));
    const { caller, stub } = callerWith(
      [
        ...fromPhotoPreamble(),
        [],
        [],
        [{ id: CATEGORY_ID, name: "Бакалея", sortOrder: 0 }],
        [],
      ],
      openai.factory,
    );

    await caller.dishImport.fromPhoto({ fileKey: FILE_KEY });

    // `statements[0]` is `householdProcedure`'s own membership lookup, which
    // is scoped by `user_id`; `statements[2]` is the rate-limit count, scoped
    // by `user_id` too; `statements[3]` is the `ai_jobs` INSERT, checked by
    // its `values` below. Everything else touches household data — including
    // `[4]`, the ledger-closing UPDATE, which this list used to skip.
    //
    // Indexes rather than a table filter on purpose: two different `ai_jobs`
    // statements are deliberately *not* household-scoped (the rate-limit read
    // is per user), so filtering by table would either fail on those or, if
    // narrowed to updates, quietly stop covering the select.
    for (const index of [1, 4, 5, 6, 7]) {
      expectScopedByHousehold(stub.statements[index]);
    }
    expect(
      (stub.statements[3]?.values as Record<string, unknown>).householdId,
    ).toBe(HOUSEHOLD_ID);
  });
});

describe("dishImport.getJob", () => {
  it("re-renders a stored draft verbatim", async () => {
    const stored = {
      outcome: "parsed" as const,
      jobId: JOB_ID,
      via: "vision" as const,
      warnings: [],
      consumedDishId: null,
      draft: {
        title: "NYC Cookies",
        photoUrl: STORED_URL,
        photoKey: FILE_KEY,
        tags: ["десерт"],
        sourceType: "photo" as const,
        sourceUrl: null,
        portionsBase: 8,
        portionsMin: 7,
        yieldUnit: "печений",
        totalTimeMin: 30,
        equipment: ["oven" as const],
        ingredients: [
          {
            rawText: "Мука — 285 г",
            name: "Мука",
            qty: 285,
            unit: "г" as const,
            note: null,
            isOptional: false,
            needsReview: false,
            productId: null,
          },
        ],
        steps: [{ text: "Выпекать", timerSec: 540, timerMaxSec: 660 }],
      },
    };

    const { caller, stub } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "done",
          inputRef: FILE_KEY,
          outputJson: stored,
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
      ],
    ]);

    await expect(caller.dishImport.getJob({ jobId: JOB_ID })).resolves.toEqual(
      stored,
    );
    expectScopedByHousehold(stub.statements[1]);
    expectScopedByJob(stub.statements[1]);
  });

  it("surfaces the dish even a failed import became", async () => {
    // «Создать вручную» saves with the same job id, so `dish.create` stamps
    // `consumedDishId` onto a *failed* document too — and reopening the
    // import URL then has to redirect rather than re-offer a dead end.
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "done",
          inputRef: FILE_KEY,
          outputJson: {
            outcome: "failed",
            jobId: JOB_ID,
            reason: "notARecipe",
            partial: {
              title: null,
              photoUrl: STORED_URL,
              photoKey: FILE_KEY,
              sourceUrl: null,
            },
            consumedDishId: DISH_ID,
          },
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
      ],
    ]);

    const result = await caller.dishImport.getJob({ jobId: JOB_ID });
    expect(result).toMatchObject({
      outcome: "failed",
      consumedDishId: DISH_ID,
    });
  });

  it("still reads a document written before consumedDishId existed", async () => {
    // `output_json` is the on-disk shape, so `getJob` parses rows written by
    // whatever deploy created them. A strictly-required new key would fail
    // validation on every older document — and the only thing `getJob` could
    // report then is `aiUnavailable`, quietly turning «на фото не рецепт»
    // into «попробуй ещё раз».
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "done",
          inputRef: FILE_KEY,
          outputJson: {
            outcome: "failed",
            jobId: JOB_ID,
            reason: "notARecipe",
            partial: {
              title: null,
              photoUrl: STORED_URL,
              photoKey: FILE_KEY,
              sourceUrl: null,
            },
          },
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
      ],
    ]);

    await expect(
      caller.dishImport.getJob({ jobId: JOB_ID }),
    ).resolves.toMatchObject({
      outcome: "failed",
      reason: "notARecipe",
      consumedDishId: null,
    });
  });

  it("does not read a URL job's input_ref as a photo key", async () => {
    // Task 4.4's `parse_url` rows carry a URL in `input_ref`. Reading it as a
    // `photoKey` would hand the client a delete handle for nothing — and put
    // an arbitrary string where a file key belongs.
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_url",
          status: "error",
          inputRef: "https://eda.ru/recepty/1",
          outputJson: null,
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
      ],
    ]);

    await expect(
      caller.dishImport.getJob({ jobId: JOB_ID }),
    ).resolves.toMatchObject({
      outcome: "failed",
      partial: {
        photoKey: null,
        sourceUrl: "https://eda.ru/recepty/1",
      },
    });
  });

  it("reports a job that has not answered yet as running", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "running",
          inputRef: FILE_KEY,
          outputJson: null,
          createdAt: new Date(Date.now() - 5_000),
        },
      ],
    ]);

    await expect(
      caller.dishImport.getJob({ jobId: JOB_ID }),
    ).resolves.toMatchObject({ outcome: "running", jobId: JOB_ID });
  });

  it("reports a job that lost its function as aiUnavailable, not as a spinner", async () => {
    // `maxDuration` is 60 s; past 90 s a `running` row is one whose Vercel
    // function died before it could close its own ledger entry.
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "running",
          inputRef: FILE_KEY,
          outputJson: null,
          createdAt: new Date(Date.now() - 120_000),
        },
      ],
    ]);

    await expect(
      caller.dishImport.getJob({ jobId: JOB_ID }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "aiUnavailable" });
  });

  it("degrades an unreadable output_json rather than failing output validation", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: JOB_ID,
          type: "parse_photo",
          status: "error",
          inputRef: FILE_KEY,
          outputJson: { something: "else" },
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
      ],
    ]);

    await expect(
      caller.dishImport.getJob({ jobId: JOB_ID }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "aiUnavailable" });
  });

  it("does not leak another household's job", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.dishImport.getJob({ jobId: JOB_ID })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });
});

describe("dishImport.discardPhoto", () => {
  // The token is stubbed *empty* rather than unstubbed: `vi.unstubAllEnvs()`
  // restores the ambient value, so on a machine that exports
  // UPLOADTHING_TOKEN this block used to fire a real credentialed
  // `POST api.uploadthing.com/v6/deleteFiles` for a synthetic key — swallowed
  // by the store's own catch, so it passed with no signal at all. The blob
  // store is injected here anyway; the empty token keeps the guard honest for
  // anything that still reaches the real one.
  beforeEach(() => {
    vi.stubEnv("UPLOADTHING_TOKEN", "");
  });

  it("refuses a key this household never uploaded", async () => {
    const { caller, stub } = discardCallerWith([[membershipRow], []]);

    await expect(
      caller.dishImport.discardPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("FORBIDDEN"));
    expect(stub.statements).toHaveLength(2);
  });

  it("refuses to delete a photo a saved dish is rendering", async () => {
    // «Отмена» on a review screen reopened after the save must not delete the
    // blob the dish now shows — neither the ownership row nor the file.
    const { caller, stub, uploadThing } = discardCallerWith([
      [membershipRow],
      photoRow,
      [{ id: DISH_ID }],
    ]);

    await expect(
      caller.dishImport.discardPhoto({ fileKey: FILE_KEY }),
    ).resolves.toEqual({ ok: false });

    expect(
      stub.statements.some((statement) => statement.kind === "delete"),
    ).toBe(false);
    // The blob is spared too. Without this, hoisting the delete above the
    // guard passes every other assertion in the file.
    expect(uploadThing.deleted).toEqual([]);

    // Both halves of the guard: the household *and* the photo_key it looks
    // up. Dropping the key predicate alone left the whole suite green.
    const lookup = stub.statements[2];
    expect(lookup?.table).toBe("dishes");
    expectScopedByHousehold(lookup);
    expect(compileWithParams(lookup?.wheres[0]).params).toContain(FILE_KEY);
  });

  it("drops the ownership row and the blob when nothing references the key", async () => {
    const { caller, stub, uploadThing } = discardCallerWith([
      [membershipRow],
      photoRow,
      [],
      [],
    ]);

    await expect(
      caller.dishImport.discardPhoto({ fileKey: FILE_KEY }),
    ).resolves.toEqual({ ok: true });

    const removed = stub.statements.find(
      (statement) => statement.kind === "delete",
    );
    expect(removed?.table).toBe("photo_uploads");
    expectScopedByHousehold(removed);
    expect(compileWithParams(removed?.wheres[0]).params).toContain(FILE_KEY);

    // The row is revoked first, then the file — and the *order* is the
    // invariant, not just that both happened: if the blob went first, a
    // failure in between would leave a live ownership row pointing at nothing,
    // and `requireOwnedPhoto` would keep accepting the key.
    const deleteAt = stub.statements.findIndex(
      (statement) => statement.kind === "delete",
    );
    expect(uploadThing.deleted).toHaveLength(1);
    expect(uploadThing.deleted[0]?.keys).toEqual([FILE_KEY]);
    expect(uploadThing.deleted[0]?.at).toBeGreaterThan(deleteAt);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 4.4 — import by URL and by pasted text
// ─────────────────────────────────────────────────────────────────────────

const RAMBLER_URL =
  "https://eda.rambler.ru/recepty/osnovnye-blyuda/kotlety-s-ovsyanymi-hlopyami-192922";
const RUSSIANFOOD_URL =
  "https://www.russianfood.com/recipes/recipe.php?rid=179072";
const INSTAGRAM_URL = "https://www.instagram.com/p/abc123/";

const RECIPE_TEXT =
  "Мука 285 г, сахар 200 г, масло сливочное 227 г, шоколад 150 г";

function fixture(name: string): string {
  return readFileSync(`src/server/recipes/__fixtures__/${name}`, "utf8");
}

/**
 * A stand-in transport that records every request and answers from a queue.
 *
 * Two things it makes assertable that nothing else can: **which URLs were
 * requested at all** (the Instagram branch must issue no direct fetch, and a
 * refused SSRF hop must issue none either), and the *order* of the page fetch
 * against the FireCrawl call.
 */
function fakePageFetch(
  responses: (Response | Error)[],
  lookupAddress = "93.184.216.34",
) {
  const requests: string[] = [];

  const fetcher = ((input: RequestInfo | URL) => {
    requests.push(String(input));
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`unexpected fetch of ${String(input)}`));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }) as unknown as typeof globalThis.fetch;

  return {
    requests,
    factory: () => ({
      fetch: fetcher,
      lookup: () => Promise.resolve([{ address: lookupAddress }]),
    }),
  };
}

function htmlPage(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function firecrawlOk(markdown: string): Response {
  return new Response(JSON.stringify({ success: true, data: { markdown } }), {
    headers: { "content-type": "application/json" },
  });
}

/** `callerWith`, plus the transport `fromUrl` needs. */
function urlCallerWith(
  results: StubResult[],
  pageFetch: () => {
    fetch: typeof globalThis.fetch;
    lookup: () => Promise<{ address: string }[]>;
  },
  openai?: () => ReturnType<ReturnType<typeof fakeOpenai>["factory"]>,
) {
  const stub = createDbStub(results);
  return {
    caller: createCaller(
      signedInContext(stub.db, openai, undefined, pageFetch),
    ),
    stub,
  };
}

/** household check → the rate-limit count → the `ai_jobs` INSERT. */
function urlPreamble(): StubResult[] {
  return [[membershipRow], rateLimitOk, jobRow];
}

/** The catalog reads and the two `ai_jobs` writes a successful import makes. */
function draftTail(): StubResult[] {
  return [
    [], // the ledger UPDATE
    [], // products
    [{ id: CATEGORY_ID, name: "Бакалея", sortOrder: 0 }],
    [], // output_json
  ];
}

const NORMALIZED_URL_RECIPE: ParsedRecipe = {
  ...RECIPE,
  title: "Котлеты с овсяными хлопьями",
  ingredients: [
    {
      rawText: "Смешанный фарш, 400 г",
      name: "Фарш",
      qty: 400,
      unit: "г",
      note: "смешанный",
      isOptional: false,
    },
  ],
};

describe("dishImport.fromUrl — the gate", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.dishImport.fromUrl({ url: RAMBLER_URL }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it.each([
    ["the loopback address", "http://127.0.0.1/recipe"],
    ["the cloud metadata service", "http://169.254.169.254/latest/meta-data/"],
    ["an internal name", "http://db.internal/recipe"],
    ["a private literal", "http://10.0.0.5/recipe"],
    ["a non-standard port", "http://example.com:6379/recipe"],
    ["credentials in the URL", "https://user:pass@example.com/recipe"],
    ["the file scheme", "file:///etc/passwd"],
  ])(
    "refuses %s at validation — no job row, no fetch, no AI",
    async (_label, url) => {
      // Decision C.8: a blocked URL is a *validation* rejection. The ledger
      // counts calls the household could be billed for, and this is not one.
      // `unusablePageFetch` and `unusableOpenai` are the context defaults, so
      // reaching either would throw something else entirely.
      const { caller, stub } = callerWith([[membershipRow]]);

      await expect(caller.dishImport.fromUrl({ url })).rejects.toSatisfy(
        hasCode("BAD_REQUEST"),
      );
      // Only `householdProcedure`'s own membership lookup ran.
      expect(stub.statements).toHaveLength(1);
      expect(stub.statements[0]?.table).toBe("household_members");
    },
  );

  it("refuses a string that is not a URL", async () => {
    const { caller } = callerWith([[membershipRow]]);

    await expect(
      caller.dishImport.fromUrl({ url: "not a url" }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("refuses when the user is over the AI rate limit, before any network", async () => {
    const { caller, stub } = urlCallerWith(
      [[membershipRow], [{ minute: 10, day: 12 }]],
      fakePageFetch([]).factory,
    );

    await expect(
      caller.dishImport.fromUrl({ url: RAMBLER_URL }),
    ).rejects.toSatisfy(hasCode("TOO_MANY_REQUESTS"));

    expect(
      stub.statements.some((statement) => statement.kind === "insert"),
    ).toBe(false);
  });
});

describe("dishImport.fromUrl — the free JSON-LD path", () => {
  it("reads eda.rambler.ru for free and still normalizes it through the model", async () => {
    // Decision D15: the AI runs on the free path too. «285 г муки» yields the
    // name «муки», which matches «Мука» under no string ranker — so skipping
    // it would fill the household's catalog with genitives.
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result).toMatchObject({ outcome: "parsed", via: "jsonld" });
    expect(result.outcome === "parsed" && result.draft).toMatchObject({
      sourceType: "url",
      sourceUrl: RAMBLER_URL,
      photoKey: null,
    });

    // Exactly one page request, and FireCrawl was never called.
    expect(page.requests).toEqual([RAMBLER_URL]);
    expect(openai.calls).toHaveLength(1);
    // The extraction reached the model as a hint, not as HTML.
    const message = String(openai.calls[0]?.params.messages[1]?.content);
    expect(message).toContain("Режим: черновик");
    expect(message).toContain("Смешанный фарш, 400 г");
    expect(message).not.toContain("<script");
  });

  it("stores the page's own image as a remote URL with no photo key", async () => {
    // Nothing was uploaded, so there is no blob of ours to discard — and
    // re-hosting somebody's photo is a bill this feature need not sign.
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result.outcome === "parsed" && result.draft.photoUrl).toMatch(
      /^https:\/\/s1\.eda\.ru\//,
    );
    expect(result.outcome === "parsed" && result.draft.photoKey).toBeNull();
  });

  it("takes povar.ru through microdata, without a FireCrawl call", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("povar-microdata.html"))]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    const result = await caller.dishImport.fromUrl({
      url: "https://povar.ru/recipes/bliny_na_moloke-473.html",
    });

    expect(result).toMatchObject({ outcome: "parsed", via: "microdata" });
    expect(page.requests).toHaveLength(1);
  });

  it("passes the normalizer the deadline's stage options and no retry", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(openai.calls[0]?.options).toMatchObject({
      timeout: 25_000,
      maxRetries: 0,
    });
    expect(openai.calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still produces a draft when the normalizer fails on a page it already read", async () => {
    // Honest degradation (blueprint §3.2): every extracted line becomes an
    // amber «уточнить» row rather than an error screen.
    const openai = fakeOpenai(new Error("connect ETIMEDOUT"));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller, stub } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result).toMatchObject({
      outcome: "parsed",
      via: "jsonld",
      warnings: ["normalizationFailed"],
    });
    expect(
      result.outcome === "parsed" && result.draft.ingredients[0],
    ).toMatchObject({ qty: null, needsReview: true });

    // The job still closes as an error, with its (zero) cost recorded.
    const ledger = stub.statements.find(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    expect((ledger?.values as Record<string, unknown>).status).toBe("error");
  });
});

describe("dishImport.fromUrl — the ledger", () => {
  it("opens exactly one job row, before the fetch", async () => {
    // Decision D16: `rate-limit.ts` counts `ai_jobs` rows, so an endpoint
    // hammered with unreachable hosts must still count against the window.
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller, stub } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    const inserts = stub.statements.filter(
      (statement) => statement.kind === "insert",
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe("ai_jobs");
    expect(inserts[0]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      userId: "user_1",
      type: "parse_url",
      status: "running",
      inputRef: RAMBLER_URL,
    });
    // Two statements before it: the membership lookup and the rate-limit
    // count. Nothing between it and the model.
    expect(stub.statements.indexOf(inserts[0]!)).toBe(2);
  });

  it("closes the row with a zero cost when the fetch itself died", async () => {
    const page = fakePageFetch([new Error("connect ETIMEDOUT")]);
    const { caller, stub } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    // No AI ran (`unusableOpenai` is the default), and the row is closed
    // anyway: a run that dies at the fetch still spent a limiter slot.
    expect(result).toMatchObject({
      outcome: "failed",
      // The *fetch's* own verdict survives the scrape's: a dead host is «не
      // удалось прочитать страницу», not «страница не отдала рецепт».
      reason: "pageUnreachable",
    });

    const ledger = stub.statements.find(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    expect((ledger?.values as Record<string, unknown>).status).toBe("error");
    expect((ledger?.values as Record<string, unknown>).costUsd).toBe(
      "0.000000",
    );
    expectScopedByHousehold(ledger);
    expectScopedByJob(ledger);
  });

  it("stamps the cost before catalog matching, so a later throw cannot lose it", async () => {
    // Decision C.2, the same pin `fromPhoto` carries: make the read *after*
    // the model reject, and the recorded cost must still be non-null.
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller, stub } = urlCallerWith(
      [
        ...urlPreamble(),
        [], // the ledger UPDATE
        new Error("catalog read failed"),
        [], // markJobError's UPDATE
      ],
      page.factory,
      openai.factory,
    );

    await expect(
      caller.dishImport.fromUrl({ url: RAMBLER_URL }),
    ).rejects.toThrow(/catalog read failed/);

    const ledgerUpdates = stub.statements.filter(
      (statement) =>
        statement.kind === "update" && statement.table === "ai_jobs",
    );
    expect(
      Number((ledgerUpdates[0]?.values as Record<string, unknown>).costUsd),
    ).toBeGreaterThan(0);
    expect((ledgerUpdates[1]?.values as Record<string, unknown>).status).toBe(
      "error",
    );
    expectScopedByJob(ledgerUpdates[0]);
    expectScopedByJob(ledgerUpdates[1]);
  });

  it("scopes every statement it issues by household", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([htmlPage(fixture("rambler-jsonld.html"))]);
    const { caller, stub } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    // `[0]` is the membership lookup (scoped by user), `[1]` the rate-limit
    // count (also per user), `[2]` the INSERT, checked by its values below.
    for (const index of [3, 4, 5, 6]) {
      expectScopedByHousehold(stub.statements[index]);
    }
    expect(
      (stub.statements[2]?.values as Record<string, unknown>).householdId,
    ).toBe(HOUSEHOLD_ID);
  });
});

describe("dishImport.fromUrl — the SSRF guard past validation", () => {
  it("refuses a redirect hop that points at the metadata service", async () => {
    // The classic bypass: a public host that 302s to 169.254.169.254. The
    // URL passed validation; only the *hop* check catches this.
    const page = fakePageFetch([
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result).toMatchObject({ outcome: "failed", reason: "blockedUrl" });
    // The redirect was read; the target was never requested, and FireCrawl
    // was never asked to fetch it either.
    expect(page.requests).toEqual([RAMBLER_URL]);
  });

  it("refuses a public name that resolves to a private address", async () => {
    const page = fakePageFetch([], "10.0.0.7");
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result).toMatchObject({ outcome: "failed", reason: "blockedUrl" });
    expect(page.requests).toEqual([]);
  });

  it("reports a body past the cap as tooLarge, without scraping it instead", async () => {
    const chunk = new Uint8Array(250_000);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 20) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const page = fakePageFetch([
      new Response(stream, { headers: { "content-type": "text/html" } }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    const result = await caller.dishImport.fromUrl({ url: RAMBLER_URL });

    expect(result).toMatchObject({ outcome: "failed", reason: "tooLarge" });
    expect(page.requests).toHaveLength(1);
  });
});

describe("dishImport.fromUrl — the FireCrawl branch", () => {
  it("scrapes a page with nothing structured on it", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const page = fakePageFetch([
      htmlPage(fixture("russianfood-plain.html")),
      firecrawlOk(`# Гуляш\n\n${"Говядина — 1 кг. ".repeat(30)}`),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), ...draftTail()],
      page.factory,
      openai.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const result = await caller.dishImport.fromUrl({ url: RUSSIANFOOD_URL });

    expect(result).toMatchObject({ outcome: "parsed", via: "firecrawl" });
    expect(page.requests[0]).toBe(RUSSIANFOOD_URL);
    expect(page.requests[1]).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(String(openai.calls[0]?.params.messages[1]?.content)).toContain(
      "Режим: текст",
    );
  });

  it("issues no direct fetch for a login wall and reports loginWalled", async () => {
    // VISION §6.4: FireCrawl almost never gets past Instagram's login page,
    // and the honest answer names the screenshot as the better road.
    const page = fakePageFetch([
      new Response(JSON.stringify({ success: false }), {
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const result = await caller.dishImport.fromUrl({ url: INSTAGRAM_URL });

    expect(result).toMatchObject({ outcome: "failed", reason: "loginWalled" });
    // FireCrawl only — instagram.com itself was never requested.
    expect(page.requests).toEqual(["https://api.firecrawl.dev/v2/scrape"]);
  });

  it("maps a FireCrawl response of the wrong shape to pageBlocked", async () => {
    // R7: a shape change degrades into S8.2's fork, never a stack trace.
    const page = fakePageFetch([
      htmlPage(fixture("russianfood-plain.html")),
      new Response(JSON.stringify({ result: { text: "…" } }), {
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const result = await caller.dishImport.fromUrl({ url: RUSSIANFOOD_URL });

    expect(result).toMatchObject({ outcome: "failed", reason: "pageBlocked" });
  });

  it("reports a thin scrape as «нет рецепта», not as a refusal", async () => {
    const page = fakePageFetch([
      htmlPage(fixture("russianfood-plain.html")),
      firecrawlOk("Cookies"),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");

    await expect(
      caller.dishImport.fromUrl({ url: RUSSIANFOOD_URL }),
    ).resolves.toMatchObject({
      outcome: "failed",
      reason: "noRecipeOnPage",
    });
  });

  it("keeps a dead host's own verdict when the scrape also fails", async () => {
    const page = fakePageFetch([
      new Error("connect ETIMEDOUT"),
      new Response(JSON.stringify({ success: false }), {
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");

    await expect(
      caller.dishImport.fromUrl({ url: RAMBLER_URL }),
    ).resolves.toMatchObject({
      outcome: "failed",
      reason: "pageUnreachable",
    });
  });

  it("prefills «создать вручную» with the page's own title", async () => {
    // VISION's «без тупика» is only true if the dead end hands you something.
    const page = fakePageFetch([
      htmlPage(fixture("russianfood-plain.html")),
      new Response("{}", { headers: { "content-type": "application/json" } }),
    ]);
    const { caller } = urlCallerWith(
      [...urlPreamble(), [], []],
      page.factory,
    );

    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const result = await caller.dishImport.fromUrl({ url: RUSSIANFOOD_URL });

    expect(result.outcome === "failed" && result.partial).toEqual({
      title: "Рецепт: Говяжий гуляш на тёмном пиве на RussianFood.com",
      photoUrl: null,
      photoKey: null,
      sourceUrl: RUSSIANFOOD_URL,
    });
  });
});

describe("dishImport.fromText", () => {
  it("runs pasted text through the same normalizer and stores the draft", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const { caller } = callerWith(
      [...urlPreamble(), ...draftTail()],
      openai.factory,
    );

    const result = await caller.dishImport.fromText({ text: RECIPE_TEXT });

    expect(result).toMatchObject({ outcome: "parsed", via: "text" });
    expect(result.outcome === "parsed" && result.draft).toMatchObject({
      sourceType: "text",
      sourceUrl: null,
      photoUrl: null,
      photoKey: null,
    });
    expect(String(openai.calls[0]?.params.messages[1]?.content)).toContain(
      RECIPE_TEXT,
    );
  });

  it("keeps only a prefix of the text in the ledger — it is not a document store", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const long = "Мука 285 г. ".repeat(50);
    const { caller, stub } = callerWith(
      [...urlPreamble(), ...draftTail()],
      openai.factory,
    );

    await caller.dishImport.fromText({ text: long });

    const insert = stub.statements.find(
      (statement) => statement.kind === "insert",
    );
    const inputRef = (insert?.values as Record<string, unknown>).inputRef;
    expect(insert?.values).toMatchObject({ type: "parse_text" });
    expect(String(inputRef)).toHaveLength("text:".length + 80);
  });

  it("refuses a text too short to be a recipe", async () => {
    const { caller } = callerWith([[membershipRow]]);

    await expect(
      caller.dishImport.fromText({ text: "мука" }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("reports an unusable answer as aiUnavailable, never as «другое фото»", async () => {
    // There is no photo on this path, so `photoUnreadable` would offer an
    // action that does not exist.
    const openai = fakeOpenai(new Error("503 Service Unavailable"));
    const { caller } = callerWith([...urlPreamble(), [], []], openai.factory);

    const result = await caller.dishImport.fromText({ text: RECIPE_TEXT });

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "aiUnavailable",
      partial: {
        title: null,
        photoUrl: null,
        photoKey: null,
        sourceUrl: null,
      },
    });
  });

  it("reports «это не рецепт» as an outcome", async () => {
    const openai = fakeOpenai(
      JSON.stringify({
        ...RECIPE,
        isRecipe: false,
        ingredients: [],
        steps: [],
      }),
    );
    const { caller } = callerWith(
      [...urlPreamble(), ...draftTail()],
      openai.factory,
    );

    await expect(
      caller.dishImport.fromText({ text: RECIPE_TEXT }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "notARecipe" });
  });

  it("scopes every statement it issues by household", async () => {
    const openai = fakeOpenai(JSON.stringify(NORMALIZED_URL_RECIPE));
    const { caller, stub } = callerWith(
      [...urlPreamble(), ...draftTail()],
      openai.factory,
    );

    await caller.dishImport.fromText({ text: RECIPE_TEXT });

    for (const index of [3, 4, 5, 6]) {
      expectScopedByHousehold(stub.statements[index]);
    }
    expect(
      (stub.statements[2]?.values as Record<string, unknown>).householdId,
    ).toBe(HOUSEHOLD_ID);
  });
});
