import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiRequestOptions } from "@/server/ai/openai";
import type { ParsedRecipe } from "@/server/ai/parse-recipe";
import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
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
const PHOTO_URL = `https://${APP_ID}.ufs.sh/f/${FILE_KEY}`;
/** What UploadThing itself returned at upload time — the stored thumbnail. */
const STORED_URL = `https://${APP_ID}.ufs.sh/f/${FILE_KEY}`;

/**
 * `fromPhoto` rebuilds the image URL from the app id inside the token, so the
 * suite needs one — synthetic, never a real project's.
 */
beforeEach(() => {
  vi.stubEnv(
    "UPLOADTHING_TOKEN",
    Buffer.from(
      JSON.stringify({ apiKey: "sk_test", appId: APP_ID, regions: ["sea1"] }),
      "utf8",
    ).toString("base64"),
  );
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
      photoUrl: PHOTO_URL,
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "печений",
    });

    // The draft is written into `output_json` by a *second*, small update, so
    // a reload can re-render the identical form.
    const stored = stub.statements.at(-1);
    expect(stored?.table).toBe("ai_jobs");
    expect(
      (stored?.values as Record<string, unknown>).outputJson,
    ).toMatchObject({ outcome: "parsed" });
    expectScopedByHousehold(stored);
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
        photoUrl: PHOTO_URL,
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
      photoUrl: PHOTO_URL,
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
    // by `user_id` too. Everything else touches household data.
    for (const index of [1, 5, 6, 7]) {
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
        photoUrl: PHOTO_URL,
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
              photoUrl: PHOTO_URL,
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

    await expect(caller.dishImport.getJob({ jobId: JOB_ID })).resolves
      .toMatchObject({
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
  // No token, so the blob delete is the no-op a token-less deployment would
  // also do — which is what keeps this suite off the network. `discardPhoto`
  // never builds an image URL, so it needs no token for anything else.
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a key this household never uploaded", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(
      caller.dishImport.discardPhoto({ fileKey: FILE_KEY }),
    ).rejects.toSatisfy(hasCode("FORBIDDEN"));
    expect(stub.statements).toHaveLength(2);
  });

  it("refuses to delete a photo a saved dish is rendering", async () => {
    // «Отмена» on a review screen reopened after the save must not delete the
    // blob the dish now shows.
    const { caller, stub } = callerWith([
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
    expectScopedByHousehold(stub.statements[2]);
  });

  it("drops the ownership row when nothing references the key", async () => {
    const { caller, stub } = callerWith([[membershipRow], photoRow, [], []]);

    await expect(
      caller.dishImport.discardPhoto({ fileKey: FILE_KEY }),
    ).resolves.toEqual({ ok: true });

    const removed = stub.statements.find(
      (statement) => statement.kind === "delete",
    );
    expect(removed?.table).toBe("photo_uploads");
    expectScopedByHousehold(removed);
    expect(compileWithParams(removed?.wheres[0]).params).toContain(FILE_KEY);
  });
});

describe("the task-4.4 stubs", () => {
  it.each([
    ["fromUrl", () => ({ url: "https://eda.rambler.ru/recipes/1" })],
    ["fromText", () => ({ text: "Мука 285 г, сахар 200 г, соль щепотка" })],
  ] as const)(
    "%s exists with its input schema and refuses to run",
    async (name, input) => {
      const { caller } = callerWith([[membershipRow]]);
      const procedure = caller.dishImport[name] as (
        value: ReturnType<typeof input>,
      ) => Promise<unknown>;

      await expect(procedure(input())).rejects.toSatisfy(
        hasCode("NOT_IMPLEMENTED"),
      );
    },
  );

  it("validates a URL before deciding it is not implemented", async () => {
    const { caller } = callerWith([[membershipRow]]);

    await expect(
      caller.dishImport.fromUrl({ url: "not a url" }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });
});
