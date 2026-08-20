import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { enrichProduct, isEmojiIcon } from "@/server/ai/enrich-product";
import type { AiChatClient } from "@/server/ai/openai";
import { AI_MODEL, computeCostUsd } from "@/server/ai/pricing";

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

const CATEGORIES = [
  { id: "cat-produce", name: "Овощи и фрукты" },
  { id: "cat-dairy", name: "Молочное и яйца" },
  { id: "cat-grocery", name: "Бакалея" },
];

const USAGE = {
  prompt_tokens: 400,
  completion_tokens: 30,
  total_tokens: 430,
  prompt_tokens_details: { cached_tokens: 0 },
};

/** A response as the API would shape it — fully typed, so no `as` casts. */
function completion(message: {
  content: string | null;
  refusal?: string | null;
}): Completion {
  const usage: Completion["usage"] = USAGE;

  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_787_000_000,
    model: AI_MODEL,
    usage,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
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

/**
 * A stand-in for the OpenAI client. Injecting one is why no test here needs
 * `OPENAI_API_KEY`, a network, or `vi.mock`.
 */
function fakeClient(respond: (params: CreateParams) => Promise<Completion>): {
  client: AiChatClient;
  calls: CreateParams[];
} {
  const calls: CreateParams[] = [];

  return {
    calls,
    client: {
      chat: {
        completions: {
          create(params) {
            calls.push(params);
            return respond(params);
          },
        },
      },
    },
  };
}

function replyWith(content: string) {
  return fakeClient(() => Promise.resolve(completion({ content })));
}

const VALID_ANSWER = JSON.stringify({
  icon: "🧀",
  categoryId: "cat-dairy",
  unit: "уп",
});

describe("enrichProduct — the happy path", () => {
  it("returns the icon, department and unit the model chose", async () => {
    const { client } = replyWith(VALID_ANSWER);

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { icon: "🧀", categoryId: "cat-dairy", unit: "уп" },
    });
  });

  it("records what the call cost", async () => {
    const { client } = replyWith(VALID_ANSWER);

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result.usage).toEqual({
      promptTokens: 400,
      cachedPromptTokens: 0,
      completionTokens: 30,
    });
    expect(result.costUsd).toBe(
      computeCostUsd({
        promptTokens: 400,
        cachedPromptTokens: 0,
        completionTokens: 30,
      }),
    );
  });

  it("calls the cheap model with low reasoning effort", async () => {
    // VISION §6.5: invisible reasoning tokens are billed as output and would
    // multiply the cost of a sub-cent call several times over.
    const { client, calls } = replyWith(VALID_ANSWER);

    await enrichProduct({ client, name: "Буррата", categories: CATEGORIES });

    expect(calls[0]).toMatchObject({
      model: AI_MODEL,
      reasoning_effort: "low",
    });
  });

  it("asks for a strict JSON schema built from the Zod schema", async () => {
    const { client, calls } = replyWith(VALID_ANSWER);

    await enrichProduct({ client, name: "Буррата", categories: CATEGORIES });

    const format = calls[0]?.response_format;
    expect(format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "enriched_product",
        strict: true,
        schema: {
          type: "object",
          // Strict mode requires both of these; they come out of
          // `z.toJSONSchema` rather than being hand-maintained.
          additionalProperties: false,
          required: ["icon", "categoryId", "unit"],
        },
      },
    });
    // `$schema` is document metadata, not part of the shape.
    expect(format).not.toHaveProperty("json_schema.schema.$schema");
  });

  it("puts every candidate department in the prompt", async () => {
    const { client, calls } = replyWith(VALID_ANSWER);

    await enrichProduct({ client, name: "Буррата", categories: CATEGORIES });

    const user = calls[0]?.messages.at(-1);
    expect(user?.content).toContain("Буррата");
    for (const category of CATEGORIES) {
      expect(user?.content).toContain(category.id);
      expect(user?.content).toContain(category.name);
    }
  });
});

describe("enrichProduct — rejected answers", () => {
  it("rejects a department that was never offered", async () => {
    // Strict mode constrains the *shape* of `categoryId`, never its value.
    // A plausible-looking invented id would otherwise file the product under
    // another household's department.
    const { client } = replyWith(
      JSON.stringify({
        icon: "🧀",
        categoryId: "cat-somebody-elses",
        unit: "уп",
      }),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("cat-somebody-elses");
  });

  it("still records the cost of an answer it rejected", async () => {
    // The request succeeded and was billed; a ledger that only counts the
    // successes under-reports exactly when things go wrong.
    const { client } = replyWith(
      JSON.stringify({ icon: "🧀", categoryId: "nope", unit: "уп" }),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result.usage).toEqual({
      promptTokens: 400,
      cachedPromptTokens: 0,
      completionTokens: 30,
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("rejects malformed JSON", async () => {
    const { client } = replyWith("{ icon: 🧀, ");

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("malformed JSON");
  });

  it("rejects an answer that misses the schema", async () => {
    const { client } = replyWith(
      JSON.stringify({ icon: "🧀", categoryId: "cat-dairy", unit: "штук" }),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("validation");
  });

  it("rejects an icon that is a word rather than an emoji", async () => {
    const { client } = replyWith(
      JSON.stringify({ icon: "сыр", categoryId: "cat-dairy", unit: "уп" }),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("non-emoji");
  });

  it("rejects an empty answer", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(completion({ content: "   " })),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("reports a refusal as a failure rather than parsing it", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(completion({ content: null, refusal: "Не могу" })),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("refused");
  });
});

describe("enrichProduct — the call itself failing", () => {
  it("never throws, whatever the client does", async () => {
    // The caller creates the product either way; an exception here would
    // turn a cosmetic miss into a failed «Создать».
    const { client } = fakeClient(() =>
      Promise.reject(new Error("connect ETIMEDOUT")),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toEqual({
      ok: false,
      error: "connect ETIMEDOUT",
      usage: null,
      costUsd: 0,
    });
  });

  it("charges nothing when the request never completed", async () => {
    const { client } = fakeClient(() => Promise.reject("boom"));

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result.usage).toBeNull();
    expect(result.costUsd).toBe(0);
  });

  it("refuses before calling anything when there are no departments", async () => {
    const { client, calls } = replyWith(VALID_ANSWER);

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: [],
    });

    expect(result).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("prices a response that reported no usage at zero", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve({
        ...completion({ content: VALID_ANSWER }),
        usage: undefined,
      }),
    );

    const result = await enrichProduct({
      client,
      name: "Буррата",
      categories: CATEGORIES,
    });

    expect(result).toMatchObject({ ok: true, costUsd: 0 });
  });
});

describe("isEmojiIcon", () => {
  it("accepts a single emoji", () => {
    for (const icon of ["🧀", "🍅", "🥑", "🛒"]) {
      expect(isEmojiIcon(icon), icon).toBe(true);
    }
  });

  it("accepts an emoji with a variation selector or a modifier", () => {
    expect(isEmojiIcon("🌶️")).toBe(true);
    expect(isEmojiIcon("✌🏽")).toBe(true);
  });

  it("rejects a word", () => {
    expect(isEmojiIcon("сыр")).toBe(false);
    expect(isEmojiIcon("cheese")).toBe(false);
  });

  it("rejects an emoji with text attached", () => {
    expect(isEmojiIcon("🧀 сыр")).toBe(false);
    expect(isEmojiIcon("icon: 🧀")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isEmojiIcon("")).toBe(false);
  });

  it("rejects a long ZWJ pile-up", () => {
    // Over four code points is a sentence, not an icon.
    expect(isEmojiIcon("👨‍👩‍👧‍👦")).toBe(false);
  });

  it("rejects a short non-ASCII word that is not a symbol", () => {
    // Cyrillic lives well below the symbol range, so "аб" is text.
    expect(isEmojiIcon("аб")).toBe(false);
  });
});
