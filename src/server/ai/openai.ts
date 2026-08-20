import OpenAI from "openai";
import { z } from "zod";

import { env } from "@/lib/env";

/**
 * The slice of the OpenAI client our code actually calls.
 *
 * Every AI function takes one of these as an argument instead of reaching for
 * a module-level singleton, so a unit test injects a fake and no test ever
 * needs `OPENAI_API_KEY`, a network, or `vi.mock`. The real client satisfies
 * it structurally.
 */
export interface AiChatClient {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

/**
 * How long a cheap structured call may take before we give up and fall back.
 * The user is watching a spinner in a bottom sheet; a product with a default
 * icon now beats the perfect icon in half a minute.
 */
const REQUEST_TIMEOUT_MS = 15_000;

let cached: OpenAI | undefined;

/**
 * The shared client. Built lazily on first use — `env()` throws on a missing
 * key, and `pnpm build` runs in CI with no environment at all, so nothing may
 * read the key at import time.
 */
export function openaiClient(): AiChatClient {
  cached ??= new OpenAI({
    apiKey: env().OPENAI_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    // One retry, not the SDK's default two: a structured-output call this
    // small either works or is having a bad day, and the fallback path is
    // instant and perfectly usable.
    maxRetries: 1,
  });
  return cached;
}

/**
 * Turns a Zod schema into a JSON Schema for OpenAI structured outputs.
 *
 * Built through Zod v4's own `z.toJSONSchema` rather than the OpenAI SDK's
 * `zodResponseFormat` helper: that helper is written against Zod v3's
 * internals, and this repo is on v4. Going through the standard converter
 * means one schema object validates the response *and* describes it to the
 * model, so the two can never drift.
 *
 * `strict: true` on OpenAI's side requires every property to be required and
 * `additionalProperties: false` on every object — which is exactly what
 * `z.toJSONSchema` emits for a plain `z.object`. The `$schema` key is dropped
 * because it is metadata about the document, not part of the shape, and
 * OpenAI's validator has no use for it.
 *
 * Corollary for schema authors: use `.nullable()`, never `.optional()`
 * (AGENTS.md) — an optional property is simply not expressible under strict
 * mode.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  });

  // Safe to mutate: `toJSONSchema` builds a fresh object per call.
  delete jsonSchema.$schema;

  return jsonSchema;
}
