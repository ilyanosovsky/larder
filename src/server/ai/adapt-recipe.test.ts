import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { emptyDraft, type RecipeDraft } from "@/lib/recipes/draft";
import {
  adaptRecipe,
  describeDraftForModel,
  type RecipeAdaptation,
} from "@/server/ai/adapt-recipe";
import type { AiChatClient, AiRequestOptions } from "@/server/ai/openai";
import { AI_MODEL, computeCostUsd } from "@/server/ai/pricing";

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

const USAGE = {
  prompt_tokens: 1_200,
  completion_tokens: 300,
  total_tokens: 1_500,
  prompt_tokens_details: { cached_tokens: 0 },
};

const ADAPTATION: RecipeAdaptation = {
  summary: "взбиваем венчиком вручную",
  ingredients: [
    { index: 1, qty: 113, unit: "г", note: "мягкое", rawText: null },
  ],
  steps: [
    { index: 0, text: "Взбить венчиком вручную", timerSec: 480, timerMaxSec: null },
  ],
  removedStepIndexes: [],
  addedSteps: [],
};

function draft(): RecipeDraft {
  return {
    ...emptyDraft(),
    title: "NYC Cookies",
    sourceType: "photo",
    portionsBase: 4,
    equipment: ["oven", "mixer"],
    ingredients: [
      {
        rawText: "Мука — 285 г",
        name: "Мука",
        qty: 142.5,
        unit: "г",
        note: null,
        isOptional: false,
        needsReview: false,
        productId: null,
      },
      {
        rawText: "Масло сливочное холодное, 227 г",
        name: "Масло сливочное",
        qty: 113.5,
        unit: "г",
        note: "холодное",
        isOptional: false,
        needsReview: false,
        productId: null,
      },
      {
        rawText: "Соль",
        name: "Соль",
        qty: null,
        unit: null,
        note: "по вкусу",
        isOptional: false,
        needsReview: false,
        productId: null,
      },
    ],
    steps: [
      { text: "Взбить масло миксером", timerSec: 180, timerMaxSec: null },
      { text: "Выпекать", timerSec: 540, timerMaxSec: 660 },
    ],
  };
}

function completion(
  message: { content: string | null; refusal?: string | null },
  finishReason: Completion["choices"][number]["finish_reason"] = "stop",
): Completion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_787_000_000,
    model: AI_MODEL,
    usage: USAGE,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content: message.content,
          refusal: message.refusal ?? null,
        },
      },
    ],
  };
}

function fakeClient(respond: (params: CreateParams) => Promise<Completion>): {
  client: AiChatClient;
  calls: { params: CreateParams; options: AiRequestOptions | undefined }[];
} {
  const calls: {
    params: CreateParams;
    options: AiRequestOptions | undefined;
  }[] = [];

  return {
    calls,
    client: {
      chat: {
        completions: {
          create(params, options) {
            calls.push({ params, options });
            return respond(params);
          },
        },
      },
    },
  };
}

function run(
  client: AiChatClient,
  overrides: Partial<Parameters<typeof adaptRecipe>[0]> = {},
) {
  return adaptRecipe({
    client,
    draft: draft(),
    profile: { equipment: ["oven", "кухонные весы"] },
    missing: ["mixer"],
    targetPortions: 4,
    basePortions: 8,
    options: { timeout: 40_000, maxRetries: 0 },
    ...overrides,
  });
}

describe("describeDraftForModel", () => {
  const prompt = describeDraftForModel({
    draft: draft(),
    profile: { equipment: ["oven", "кухонные весы"] },
    missing: ["mixer"],
    targetPortions: 4,
    basePortions: 8,
  });

  it("numbers ingredients and steps from zero", () => {
    // The pairing that matters: the prompt hands out the indexes
    // `applyAdaptation` resolves against, and an off-by-one here would
    // produce a proposal that is wrong on every row and still validates.
    expect(prompt).toContain("0. Мука — 285 г | 142.5 г");
    expect(prompt).toContain("1. Масло сливочное холодное, 227 г (холодное)");
    expect(prompt).toContain("0. Взбить масло миксером [таймер 180 с]");
    expect(prompt).toContain("1. Выпекать [таймер 540–660 с]");
  });

  it("says the arithmetic is done, and states the numbers as final", () => {
    // The first real run halved an already-halved recipe; the prompt now says
    // so three ways over.
    expect(prompt).toContain("Порций: 4 (было 8)");
    expect(prompt).toContain("ПЕРЕСЧЁТ УЖЕ СДЕЛАН");
    expect(prompt).toContain("Ничего не дели и не умножай");
  });

  it("never puts the household headcount in front of the model", () => {
    // Evidence, not taste: with «В доме человек: 2» present, gpt-5-mini
    // adapted «пересчитано на 2 человека (всё вдвое меньше)» — it read the
    // headcount as the portion target. See `AdaptProfile`.
    expect(prompt).not.toContain("В доме");
    expect(prompt).not.toMatch(/человек/);
  });

  it("states the recipe's own yield when nothing is being rescaled", () => {
    const plain = describeDraftForModel({
      draft: draft(),
      profile: { equipment: [] },
      missing: ["mixer"],
      targetPortions: null,
      basePortions: 8,
    });

    expect(plain).toContain("Порций: 8 (количества указаны для них)");
    expect(plain).not.toContain("ПЕРЕСЧЁТ");
  });

  it("names the missing appliance in Russian, not as a slug", () => {
    expect(prompt).toContain("НЕТ на кухне (от этого нужно уйти): миксер");
    expect(prompt).not.toContain("mixer");
  });

  it("lists the household's own equipment, presets translated and free text kept", () => {
    expect(prompt).toContain("Есть на кухне: духовка, кухонные весы");
  });

  it("tells the model to propose manual work when the kitchen is empty", () => {
    const bare = describeDraftForModel({
      draft: draft(),
      profile: { equipment: [] },
      missing: ["mixer"],
      targetPortions: null,
      basePortions: 8,
    });

    expect(bare).toContain("ничего из техники не указано");
  });

  it("marks an unstated quantity as unstated rather than as zero", () => {
    expect(prompt).toContain("2. Соль (по вкусу) | количество не указано");
  });
});

describe("adaptRecipe", () => {
  it("asks for the cheap model at low effort, with the caller's own timeout", async () => {
    const { client, calls } = fakeClient(() =>
      Promise.resolve(completion({ content: JSON.stringify(ADAPTATION) })),
    );

    await run(client);

    expect(calls[0]?.params.model).toBe(AI_MODEL);
    expect(calls[0]?.params.reasoning_effort).toBe("low");
    expect(calls[0]?.params.max_completion_tokens).toBeGreaterThan(0);
    // Per request, never a second cached client (decision C.1).
    expect(calls[0]?.options).toEqual({ timeout: 40_000, maxRetries: 0 });
  });

  it("asks for a strict schema with no validation keywords in it", async () => {
    const { client, calls } = fakeClient(() =>
      Promise.resolve(completion({ content: JSON.stringify(ADAPTATION) })),
    );

    await run(client);

    const format = calls[0]?.params.response_format;
    expect(format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "recipe_adaptation", strict: true },
    });
    // The shape itself is walked by `adapt-recipe.schema.test.ts`; this only
    // pins that the strict schema is what actually goes out.
    expect(JSON.stringify(format)).not.toContain("minimum");
  });

  it("returns the proposal with the usage it was billed for", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(completion({ content: JSON.stringify(ADAPTATION) })),
    );

    const result = await run(client);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.value).toEqual(ADAPTATION);
    expect(result.costUsd).toBe(
      computeCostUsd({
        promptTokens: USAGE.prompt_tokens,
        cachedPromptTokens: 0,
        completionTokens: USAGE.completion_tokens,
      }),
    );
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("never throws for a network failure, and bills nothing for it", async () => {
    const { client } = fakeClient(() => Promise.reject(new Error("socket hang up")));

    const result = await run(client);

    expect(result).toMatchObject({
      ok: false,
      reason: "aiUnavailable",
      error: "socket hang up",
      usage: null,
      costUsd: 0,
    });
  });

  it("never throws for an API error either", async () => {
    const { client } = fakeClient(() =>
      Promise.reject(
        new OpenAI.APIError(500, undefined, "upstream is unhappy", undefined),
      ),
    );

    await expect(run(client)).resolves.toMatchObject({
      ok: false,
      reason: "aiUnavailable",
    });
  });

  it.each([
    ["malformed JSON", { content: "не json" }, "stop" as const],
    ["empty content", { content: "" }, "stop" as const],
    ["no content at all", { content: null }, "stop" as const],
    [
      "a refusal",
      { content: null, refusal: "не могу" },
      "stop" as const,
    ],
  ])("reports %s as a billed failure", async (_label, message, finish) => {
    const { client } = fakeClient(() =>
      Promise.resolve(completion(message, finish)),
    );

    const result = await run(client);

    expect(result.ok).toBe(false);
    // The response arrived and was paid for; a ledger that counted only
    // successes would under-report exactly when things go wrong.
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("reports a truncated answer rather than trying to parse it", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(
        completion({ content: '{"summary":"переде' }, "length"),
      ),
    );

    await expect(run(client)).resolves.toMatchObject({
      ok: false,
      error: "Model output hit the token ceiling",
    });
  });

  it("refuses a well-formed answer that is the wrong shape", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(
        completion({
          content: JSON.stringify({ ...ADAPTATION, removedStepIndexes: "все" }),
        }),
      ),
    );

    const result = await run(client);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error).toContain("removedStepIndexes");
  });

  it("returns a failure, not a crash, when the model returns no choices", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve({ ...completion({ content: "{}" }), choices: [] }),
    );

    await expect(run(client)).resolves.toMatchObject({
      ok: false,
      error: "Model returned no choices",
    });
  });
});
