import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type { AiChatClient, AiRequestOptions } from "@/server/ai/openai";
import { parseRecipe, type ParsedRecipe } from "@/server/ai/parse-recipe";
import { AI_MODEL, computeCostUsd } from "@/server/ai/pricing";

type CreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

const IMAGE_URL = "https://app1.ufs.sh/f/abc123";

const USAGE = {
  prompt_tokens: 1_600,
  completion_tokens: 900,
  total_tokens: 2_500,
  prompt_tokens_details: { cached_tokens: 0 },
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
  steps: [{ text: "Смешать", timerSec: 540, timerMaxSec: 660 }],
};

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

function replyWith(content: string) {
  return fakeClient(() => Promise.resolve(completion({ content })));
}

function photo(client: AiChatClient, options?: AiRequestOptions) {
  return parseRecipe({
    client,
    input: { kind: "photo", imageUrl: IMAGE_URL },
    options,
  });
}

describe("the request", () => {
  it("sends the image at detail:high", async () => {
    // The whole feature is reading small digits off a screenshot; `"low"`
    // downsamples to 512 px, and «285 г» read as «235 г» is the one failure
    // the review screen cannot catch.
    const fake = replyWith(JSON.stringify(RECIPE));
    await photo(fake.client);

    const message = fake.calls[0]?.params.messages[1];
    expect(message?.content).toEqual([
      { type: "text", text: expect.stringContaining("Режим: фото") },
      {
        type: "image_url",
        image_url: { url: IMAGE_URL, detail: "high" },
      },
    ]);
  });

  it("uses the cheap model at low reasoning effort with a token ceiling", async () => {
    const fake = replyWith(JSON.stringify(RECIPE));
    await photo(fake.client);

    const params = fake.calls[0]?.params;
    expect(params?.model).toBe(AI_MODEL);
    expect(params?.reasoning_effort).toBe("low");
    expect(params?.max_completion_tokens).toBeGreaterThan(0);
  });

  it("asks for the strict schema by name", async () => {
    const fake = replyWith(JSON.stringify(RECIPE));
    await photo(fake.client);

    const format = fake.calls[0]?.params.response_format;
    expect(format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "parsed_recipe", strict: true },
    });
  });

  it("passes the caller's per-request options straight through", async () => {
    // The import needs 40 s and zero retries; the shared client is built for
    // a 15 s icon lookup with one retry. A dropped option would double both
    // the wait and the bill without failing any other assertion.
    const controller = new AbortController();
    const fake = replyWith(JSON.stringify(RECIPE));
    await photo(fake.client, {
      timeout: 40_000,
      maxRetries: 0,
      signal: controller.signal,
    });

    expect(fake.calls[0]?.options).toEqual({
      timeout: 40_000,
      maxRetries: 0,
      signal: controller.signal,
    });
  });

  it("sends text mode as a plain string, with no image part", async () => {
    const fake = replyWith(JSON.stringify(RECIPE));
    await parseRecipe({
      client: fake.client,
      input: { kind: "text", text: "Мука 285 г" },
    });

    const content = fake.calls[0]?.params.messages[1]?.content;
    expect(typeof content).toBe("string");
    expect(content).toContain("Мука 285 г");
  });

  it("names the recipe units in the prompt without making them an enum", async () => {
    // The schema keeps `unit` a free string on purpose; the prompt is where
    // the canon is mentioned, as guidance rather than as a constraint.
    const fake = replyWith(JSON.stringify(RECIPE));
    await photo(fake.client);

    const system = fake.calls[0]?.params.messages[0]?.content;
    expect(String(system)).toContain("ч.л.");
    expect(String(system)).toContain("НЕ ВЫДУМЫВАЙ");
  });
});

describe("the answer", () => {
  it("returns the parsed recipe and its cost", async () => {
    const fake = replyWith(JSON.stringify(RECIPE));
    const result = await photo(fake.client);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual(RECIPE);
    expect(result.costUsd).toBe(
      computeCostUsd({
        promptTokens: 1_600,
        cachedPromptTokens: 0,
        completionTokens: 900,
      }),
    );
  });

  it("passes isRecipe:false through as a successful parse", async () => {
    // Not a failure of the call — a fact about the photo. `draftFromParsed`
    // is what turns it into the `notARecipe` outcome.
    const notARecipe = {
      ...RECIPE,
      isRecipe: false,
      ingredients: [],
      steps: [],
    };
    const fake = replyWith(JSON.stringify(notARecipe));
    const result = await photo(fake.client);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.isRecipe).toBe(false);
  });
});

describe("failures", () => {
  it("never throws on a network error, and records no cost", async () => {
    const fake = fakeClient(() =>
      Promise.reject(new Error("connect ETIMEDOUT")),
    );
    const result = await photo(fake.client);

    expect(result).toMatchObject({
      ok: false,
      reason: "aiUnavailable",
      usage: null,
      costUsd: 0,
    });
  });

  it("maps an aborted request to aiUnavailable", async () => {
    const fake = fakeClient(() =>
      Promise.reject(new Error("The operation was aborted")),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      ok: false,
      reason: "aiUnavailable",
    });
  });

  it("records the cost of a refusal — it was still billed", async () => {
    const fake = fakeClient(() =>
      Promise.resolve(completion({ content: null, refusal: "не могу" })),
    );
    const result = await photo(fake.client);

    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.ok === false && result.reason).toBe("photoUnreadable");
  });

  it("records the cost of malformed JSON", async () => {
    const result = await photo(replyWith("{ not json").client);

    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.ok === false && result.reason).toBe("photoUnreadable");
  });

  it("records the cost of a schema-invalid answer", async () => {
    const result = await photo(
      replyWith(JSON.stringify({ ...RECIPE, ingredients: "нет" })).client,
    );

    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.ok === false && result.reason).toBe("photoUnreadable");
  });

  it("maps a truncated answer to aiUnavailable, not to an unreadable photo", async () => {
    // The photo was fine; the answer ran out of room. «Попробуй ещё раз» is
    // the useful offer, «попробуй другой скриншот» is not.
    const fake = fakeClient(() =>
      Promise.resolve(completion({ content: '{"isRecipe":' }, "length")),
    );
    const result = await photo(fake.client);

    expect(result.ok === false && result.reason).toBe("aiUnavailable");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it.each([
    "invalid_image_format",
    "invalid_image_url",
    "image_parse_error",
    "unsupported_image_media_type",
  ])("maps the image-specific 400 %s to photoUnreadable", async (code) => {
    // The reason picks the fallback: `aiUnavailable` leads with «Ещё раз»,
    // which re-runs the import against the same file key and fails
    // identically, and never offers «Другое фото» — the one action that
    // discards the unusable blob. A HEIC picked in desktop Chrome reaches the
    // vision call exactly this way.
    //
    // **The body's `message` is deliberately image-free.** `APIError.makeMessage`
    // ignores its `message` argument whenever the body is truthy and
    // serializes the body instead — so `{ code }` alone produced the message
    // `400 {"code":"invalid_image_format"}`, which the `/image/i` fallback
    // matched on its own. Every one of these four cases passed *without* the
    // code table, and replacing the whole guard with `if (false)` kept the
    // suite green. With a real message only `IMAGE_ERROR_CODES` can decide.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          { code, message: "Запрос отклонён" },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      ok: false,
      reason: "photoUnreadable",
    });
  });

  it("maps a 415 to photoUnreadable", async () => {
    // The media-type branch — nothing else in the suite constructs one.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.APIError(
          415,
          { code: "unsupported_media_type", message: "Тип не поддерживается" },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "photoUnreadable",
    });
  });

  it("recovers the case the message alone gets wrong", async () => {
    // The realistic body that motivates the table at all: OpenAI names the
    // image in the *code* and says nothing about it in the message, so the
    // regex fallback would route this to «Ещё раз» — a retry against the same
    // undecodable file, forever.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          {
            code: "invalid_image_url",
            message: "Timeout while fetching the file.",
          },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "photoUnreadable",
    });
  });

  it("treats the code table as a whitelist, not «any 400 with a code»", async () => {
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          { code: "rate_limit_exceeded", message: "Слишком много запросов" },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "aiUnavailable",
    });
  });

  it("maps a bare 400 whose message names the image to photoUnreadable", async () => {
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          { message: "Invalid image: the image could not be decoded" },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "photoUnreadable",
    });
  });

  it("leaves a 400 about fetching the URL as aiUnavailable", async () => {
    // The one this actually happened to in testing: «Unable to download
    // content from the provided URL before the timeout» — a cold CDN object
    // right after upload, which a retry fixed. The picture was fine, so
    // «Ещё раз» is the right offer and «другое фото» would be a lie.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          {
            message:
              "Unable to download content from the provided URL before the timeout.",
          },
          undefined,
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "aiUnavailable",
    });
  });

  it("leaves a schema 400 as aiUnavailable — «другое фото» would not help", async () => {
    // A strict-mode or schema rejection is our bug, not the picture's, and
    // sending someone off to pick another screenshot is a loop with no end.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          { code: "invalid_request_error" },
          "Invalid schema for response_format",
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "aiUnavailable",
    });
  });

  it.each([429, 500, 503])("leaves a %s as aiUnavailable", async (status) => {
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.APIError(
          status,
          { code: "server_error" },
          "boom",
          new Headers(),
        ),
      ),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      reason: "aiUnavailable",
    });
  });

  it("never blames the picture on the text path", async () => {
    // There is no photo to swap out, so «попробуй другой скриншот» is nonsense.
    const fake = fakeClient(() =>
      Promise.reject(
        new OpenAI.BadRequestError(
          400,
          { code: "invalid_image_format" },
          "bad image",
          new Headers(),
        ),
      ),
    );

    await expect(
      parseRecipe({ client: fake.client, input: { kind: "text", text: "x" } }),
    ).resolves.toMatchObject({ reason: "aiUnavailable" });
  });

  it("handles a response with no choices at all", async () => {
    const fake = fakeClient(() =>
      Promise.resolve({ ...completion({ content: null }), choices: [] }),
    );

    await expect(photo(fake.client)).resolves.toMatchObject({
      ok: false,
      reason: "aiUnavailable",
    });
  });

  it("handles empty content without throwing", async () => {
    await expect(photo(replyWith("   ").client)).resolves.toMatchObject({
      ok: false,
      reason: "aiUnavailable",
    });
  });
});
