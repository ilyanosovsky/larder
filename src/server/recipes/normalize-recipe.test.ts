import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import type { AiChatClient } from "@/server/ai/openai";
import type { ParsedRecipe } from "@/server/ai/parse-recipe";

import { normalizeRecipe } from "./normalize-recipe";
import { EMPTY_SKELETON, type RecipeSkeleton } from "./skeleton";

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

const SKELETON: RecipeSkeleton = {
  ...EMPTY_SKELETON,
  title: "Печенье NYC",
  yieldText: "7–8 печений",
  ingredients: ["Мука — 285 г", "Шоколад крупными кусками — 150 г"],
  steps: ["Взбей масло с сахаром."],
};

const NORMALIZED: ParsedRecipe = {
  isRecipe: true,
  title: "Печенье NYC",
  portionsBase: 8,
  portionsMin: 7,
  yieldUnit: "печений",
  totalTimeMin: 75,
  equipment: ["духовка"],
  tags: ["десерт"],
  ingredients: [
    {
      rawText: "Мука — 285 г",
      // The whole point of running the model on the free path: «муки» matches
      // no product in any catalog, «Мука» matches the household's own.
      name: "Мука",
      qty: 285,
      unit: "г",
      note: null,
      isOptional: false,
    },
  ],
  steps: [
    { text: "Взбей масло с сахаром.", timerSec: null, timerMaxSec: null },
  ],
};

function fakeClient(answer: string | Error) {
  const calls: CreateParams[] = [];

  const client: AiChatClient = {
    chat: {
      completions: {
        create(params: CreateParams) {
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
              prompt_tokens: 900,
              completion_tokens: 400,
              total_tokens: 1_300,
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
  };

  return { client, calls };
}

describe("normalizeRecipe — the free path still goes through the model (D15)", () => {
  it("sends the extraction as a hint in the shared prompt's skeleton mode", async () => {
    const { client, calls } = fakeClient(JSON.stringify(NORMALIZED));

    const result = await normalizeRecipe({
      client,
      input: { kind: "skeleton", skeleton: SKELETON },
    });

    expect(result.parsed?.ingredients[0]?.name).toBe("Мука");
    expect(result.warnings).toEqual([]);
    expect(result.costUsd).toBeGreaterThan(0);

    const message = String(calls[0]?.messages[1]?.content);
    expect(message).toContain("Режим: черновик");
    expect(message).toContain("- Мука — 285 г");
    // The model never sees raw HTML — only the lines we already extracted.
    expect(message).not.toContain("<");
  });

  it("keeps the import alive when the model fails on a page we already read", async () => {
    // Honest degradation: an editable draft wearing «уточнить» chips beats an
    // error screen for a page whose ingredients are sitting right there.
    const { client } = fakeClient(new Error("connect ETIMEDOUT"));

    const result = await normalizeRecipe({
      client,
      input: { kind: "skeleton", skeleton: SKELETON },
    });

    expect(result.warnings).toEqual(["normalizationFailed"]);
    expect(result.reason).toBeNull();
    expect(result.parsed?.ingredients.map((row) => row.rawText)).toEqual([
      "Мука — 285 г",
      "Шоколад крупными кусками — 150 г",
    ]);
    expect(result.parsed?.ingredients[0]?.qty).toBeNull();
    // The failure is still recorded, for the ledger.
    expect(result.error).toContain("ETIMEDOUT");
  });

  it("records the cost of an answer that arrived and then failed validation", async () => {
    const { client } = fakeClient("{ not json");

    const result = await normalizeRecipe({
      client,
      input: { kind: "skeleton", skeleton: SKELETON },
    });

    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.warnings).toEqual(["normalizationFailed"]);
  });
});

describe("normalizeRecipe — markdown and pasted text", () => {
  it("sends FireCrawl's markdown through the prompt's text mode", async () => {
    const { client, calls } = fakeClient(JSON.stringify(NORMALIZED));

    const result = await normalizeRecipe({
      client,
      input: { kind: "markdown", markdown: "# Гуляш\n\nГовядина — 1 кг" },
    });

    expect(result.parsed?.title).toBe("Печенье NYC");
    const message = String(calls[0]?.messages[1]?.content);
    expect(message).toContain("Режим: текст");
    expect(message).toContain("Говядина — 1 кг");
  });

  it("sends pasted text through the same mode — there is no second parser", async () => {
    const { client, calls } = fakeClient(JSON.stringify(NORMALIZED));

    await normalizeRecipe({
      client,
      input: { kind: "text", text: "Мука 285 г, сахар 200 г" },
    });

    expect(String(calls[0]?.messages[1]?.content)).toContain("Мука 285 г");
  });

  it("has no fallback when the model fails — a wall of text is not a recipe", async () => {
    const { client } = fakeClient(new Error("503 Service Unavailable"));

    const result = await normalizeRecipe({
      client,
      input: { kind: "text", text: "что-то" },
    });

    expect(result.parsed).toBeNull();
    expect(result.reason).toBe("aiUnavailable");
    expect(result.warnings).toEqual([]);
  });

  it("never reports «попробуй другой скриншот» — there is no photo", async () => {
    // `reasonFor` classifies image-specific 400s, but only on the photo path.
    const { client } = fakeClient(new Error("invalid image format"));

    const result = await normalizeRecipe({
      client,
      input: { kind: "markdown", markdown: "что-то" },
    });

    expect(result.reason).toBe("aiUnavailable");
  });
});

describe("normalizeRecipe — the request options", () => {
  it("passes the deadline's stage timeout and refuses to retry", async () => {
    const create = vi.fn(() =>
      Promise.reject(new Error("boom")),
    ) as unknown as AiChatClient["chat"]["completions"]["create"];
    const signal = AbortSignal.timeout(5_000);

    await normalizeRecipe({
      client: { chat: { completions: { create } } },
      input: { kind: "text", text: "что-то" },
      options: { timeout: 25_000, maxRetries: 0, signal },
    });

    expect(vi.mocked(create).mock.calls[0]?.[1]).toMatchObject({
      timeout: 25_000,
      maxRetries: 0,
      signal,
    });
  });
});
