import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import {
  enrichedProductsSchema,
  enrichProducts,
  MAX_ENRICH_NAMES,
} from "@/server/ai/enrich-products";
import { toStrictJsonSchema, type AiChatClient } from "@/server/ai/openai";
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
  prompt_tokens: 600,
  completion_tokens: 80,
  total_tokens: 680,
  prompt_tokens_details: { cached_tokens: 0 },
};

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

function replyWithItems(
  items: { name: string; icon: string; categoryId: string; unit: string }[],
) {
  return replyWith(JSON.stringify({ items }));
}

const BILLED = computeCostUsd({
  promptTokens: USAGE.prompt_tokens,
  completionTokens: USAGE.completion_tokens,
  totalTokens: USAGE.total_tokens,
  cachedPromptTokens: 0,
});

describe("enrichProducts — the happy path", () => {
  it("answers every name in one call, in the order asked", async () => {
    const { client, calls } = replyWithItems([
      { name: "Дукка", icon: "🥜", categoryId: "cat-grocery", unit: "г" },
      { name: "Буррата", icon: "🧀", categoryId: "cat-dairy", unit: "шт" },
    ]);

    const result = await enrichProducts({
      client,
      names: ["Буррата", "Дукка"],
      categories: CATEGORIES,
    });

    // One call for the whole recipe — ten sequential ones would burn the
    // function's duration budget and ten rate-limit slots on one save.
    expect(calls).toHaveLength(1);
    expect(result.values).toEqual([
      { icon: "🧀", categoryId: "cat-dairy", unit: "шт" },
      { icon: "🥜", categoryId: "cat-grocery", unit: "г" },
    ]);
    expect(result.error).toBeNull();
    expect(result.costUsd).toBeCloseTo(BILLED, 10);
  });

  it("pairs answers by name, not by position", async () => {
    // A model that reorders (or drops one) must not shift every later
    // product onto the wrong ingredient.
    const { client } = replyWithItems([
      { name: "Дукка", icon: "🥜", categoryId: "cat-grocery", unit: "г" },
    ]);

    const result = await enrichProducts({
      client,
      names: ["Буррата", "Дукка"],
      categories: CATEGORIES,
    });

    expect(result.values[0]).toBeNull();
    expect(result.values[1]).toEqual({
      icon: "🥜",
      categoryId: "cat-grocery",
      unit: "г",
    });
    expect(result.error).toContain("1/2");
  });

  it("sends the model a low reasoning effort and the strict schema", async () => {
    const { client, calls } = replyWithItems([]);

    await enrichProducts({
      client,
      names: ["Буррата"],
      categories: CATEGORIES,
    });

    const params = calls[0];
    expect(params?.model).toBe(AI_MODEL);
    expect(params?.reasoning_effort).toBe("low");
    expect(params?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "enriched_products", strict: true },
    });
  });
});

describe("enrichProducts — per-name validation", () => {
  it("rejects an unknown categoryId for that name only", async () => {
    const { client } = replyWithItems([
      { name: "Буррата", icon: "🧀", categoryId: "cat-elsewhere", unit: "шт" },
      { name: "Дукка", icon: "🥜", categoryId: "cat-grocery", unit: "г" },
    ]);

    const result = await enrichProducts({
      client,
      names: ["Буррата", "Дукка"],
      categories: CATEGORIES,
    });

    // Strict mode constrains the shape of `categoryId`, never its value — an
    // invented id would file a product into another household's department.
    expect(result.values[0]).toBeNull();
    expect(result.values[1]).not.toBeNull();
  });

  it("rejects a non-emoji icon for that name only", async () => {
    const { client } = replyWithItems([
      { name: "Буррата", icon: "сыр", categoryId: "cat-dairy", unit: "шт" },
      { name: "Дукка", icon: "🥜", categoryId: "cat-grocery", unit: "г" },
    ]);

    const result = await enrichProducts({
      client,
      names: ["Буррата", "Дукка"],
      categories: CATEGORIES,
    });

    expect(result.values[0]).toBeNull();
    expect(result.values[1]).not.toBeNull();
  });

  it("matches names the way the catalog does — case and ё folded", async () => {
    const { client } = replyWithItems([
      { name: "гречка", icon: "🌾", categoryId: "cat-grocery", unit: "кг" },
    ]);

    const result = await enrichProducts({
      client,
      names: ["Гречка"],
      categories: CATEGORIES,
    });

    expect(result.values[0]).toEqual({
      icon: "🌾",
      categoryId: "cat-grocery",
      unit: "кг",
    });
  });
});

describe("enrichProducts — failure, and what it still records", () => {
  it("never throws on malformed JSON, and records what was billed", async () => {
    const { client } = replyWith("не json");

    const result = await enrichProducts({
      client,
      names: ["Буррата"],
      categories: CATEGORIES,
    });

    expect(result.values).toEqual([null]);
    expect(result.error).toContain("malformed JSON");
    // The response came back and was billed; a ledger that only counts
    // successes under-reports exactly when things go wrong.
    expect(result.costUsd).toBeCloseTo(BILLED, 10);
  });

  it("never throws on a refusal", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve(completion({ content: null, refusal: "no" })),
    );

    const result = await enrichProducts({
      client,
      names: ["Буррата"],
      categories: CATEGORIES,
    });

    expect(result.error).toContain("refused");
    expect(result.costUsd).toBeCloseTo(BILLED, 10);
  });

  it("never throws on a schema-invalid answer", async () => {
    const { client } = replyWith(
      JSON.stringify({ items: [{ name: "Буррата", icon: "🧀" }] }),
    );

    const result = await enrichProducts({
      client,
      names: ["Буррата"],
      categories: CATEGORIES,
    });

    expect(result.error).toContain("validation");
    expect(result.values).toEqual([null]);
  });

  it("never throws when the request itself fails, and bills nothing", async () => {
    const { client } = fakeClient(() => Promise.reject(new Error("ECONNRESET")));

    const result = await enrichProducts({
      client,
      names: ["Буррата"],
      categories: CATEGORIES,
    });

    expect(result.error).toBe("ECONNRESET");
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBe(0);
  });

  it("refuses to answer at all without departments to choose from", async () => {
    const { client, calls } = replyWithItems([]);

    const result = await enrichProducts({
      client,
      names: ["Буррата"],
      categories: [],
    });

    expect(calls).toHaveLength(0);
    expect(result.values).toEqual([null]);
    expect(result.error).toContain("No categories");
  });
});

describe("enrichProducts — what is never sent", () => {
  it("asks nothing for an empty list", async () => {
    const { client, calls } = replyWithItems([]);

    const result = await enrichProducts({
      client,
      names: [],
      categories: CATEGORIES,
    });

    expect(calls).toHaveLength(0);
    expect(result.values).toEqual([]);
    expect(result.costUsd).toBe(0);
  });

  it("never sends a name with no usable text", async () => {
    const { client, calls } = replyWithItems([
      { name: "Буррата", icon: "🧀", categoryId: "cat-dairy", unit: "шт" },
    ]);

    await enrichProducts({
      client,
      names: ["   ", "Буррата"],
      categories: CATEGORIES,
    });

    const content = calls[0]?.messages[1]?.content;
    expect(typeof content).toBe("string");
    expect(String(content)).toContain("Буррата");
    expect(String(content).split("\n")[1]).toBe("Буррата");
  });

  it("caps one call at MAX_ENRICH_NAMES, and the rest fall back", async () => {
    const names = Array.from(
      { length: MAX_ENRICH_NAMES + 3 },
      (_, index) => `Продукт ${index}`,
    );
    const { client, calls } = replyWithItems(
      names.map((name) => ({
        name,
        icon: "🥫",
        categoryId: "cat-grocery",
        unit: "шт",
      })),
    );

    const result = await enrichProducts({
      client,
      names,
      categories: CATEGORIES,
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.messages[1]?.content)).not.toContain(
      `Продукт ${MAX_ENRICH_NAMES}`,
    );
    expect(result.values).toHaveLength(names.length);
  });
});

describe("the strict JSON schema it sends", () => {
  it("carries no bound OpenAI strict mode would reject", () => {
    const schema = toStrictJsonSchema(enrichedProductsSchema);
    const seen = JSON.stringify(schema);

    for (const banned of [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "format",
      "pattern",
      "minItems",
      "maxItems",
    ]) {
      expect(seen).not.toContain(banned);
    }
    expect(seen).not.toContain("$schema");
  });

  it("marks every object closed, at every depth", () => {
    const schema = toStrictJsonSchema(enrichedProductsSchema) as Record<
      string,
      unknown
    >;

    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
      if (typeof node !== "object" || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === "object") {
        objects.push(record);
      }
      for (const value of Object.values(record)) {
        walk(value);
      }
    };
    walk(schema);

    expect(objects.length).toBeGreaterThanOrEqual(2);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      const properties = Object.keys(
        (object.properties ?? {}) as Record<string, unknown>,
      );
      expect([...(object.required as string[])].sort()).toEqual(
        [...properties].sort(),
      );
    }
  });
});
