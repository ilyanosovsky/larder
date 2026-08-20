import { describe, expect, it } from "vitest";

import {
  AI_PRICE_PER_MTOK,
  computeCostUsd,
  formatCostUsd,
  usageFrom,
} from "@/server/ai/pricing";

describe("computeCostUsd", () => {
  it("prices a plain call at the published per-million rates", () => {
    // 1,000,000 input + 1,000,000 output = one unit of each rate.
    expect(
      computeCostUsd({
        promptTokens: 1_000_000,
        cachedPromptTokens: 0,
        completionTokens: 1_000_000,
      }),
    ).toBe(AI_PRICE_PER_MTOK.input + AI_PRICE_PER_MTOK.output);
  });

  it("prices a realistic icon lookup at a fraction of a cent", () => {
    // 400 prompt + 30 completion — the shape of one product enrichment.
    // 400 × 0.25/1e6 = 0.0001, 30 × 2.0/1e6 = 0.00006.
    expect(
      computeCostUsd({
        promptTokens: 400,
        cachedPromptTokens: 0,
        completionTokens: 30,
      }),
    ).toBe(0.00016);
  });

  it("bills cached prompt tokens at the cached rate, and only once", () => {
    // Cached tokens are a *subset* of the prompt: 1000 prompt with 800
    // cached is 200 at the full rate plus 800 at the cached rate.
    const cost = computeCostUsd({
      promptTokens: 1_000_000,
      cachedPromptTokens: 800_000,
      completionTokens: 0,
    });

    expect(cost).toBeCloseTo(
      0.2 * AI_PRICE_PER_MTOK.input + 0.8 * AI_PRICE_PER_MTOK.cachedInput,
      9,
    );
  });

  it("is zero for a call that reported no tokens", () => {
    expect(
      computeCostUsd({
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
      }),
    ).toBe(0);
  });

  it("clamps a cached count larger than the prompt itself", () => {
    // Nonsense from the API must not price part of the request negatively.
    expect(
      computeCostUsd({
        promptTokens: 100,
        cachedPromptTokens: 500,
        completionTokens: 0,
      }),
    ).toBe(
      computeCostUsd({
        promptTokens: 100,
        cachedPromptTokens: 100,
        completionTokens: 0,
      }),
    );
  });

  it("rounds to the six decimals the numeric(10, 6) column stores", () => {
    const cost = computeCostUsd({
      promptTokens: 1,
      cachedPromptTokens: 0,
      completionTokens: 1,
    });

    expect(cost).toBe(0.000002);
    expect(formatCostUsd(cost)).toBe("0.000002");
  });
});

describe("usageFrom", () => {
  it("reads the token counts off a completion", () => {
    expect(
      usageFrom({
        prompt_tokens: 420,
        completion_tokens: 31,
        prompt_tokens_details: { cached_tokens: 128 },
      }),
    ).toEqual({
      promptTokens: 420,
      cachedPromptTokens: 128,
      completionTokens: 31,
    });
  });

  it("treats a missing usage block as zero rather than crashing", () => {
    // A zero-cost job is a survivable wrong answer; NaN written into
    // numeric(10, 6) is not.
    expect(usageFrom(undefined)).toEqual({
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
    });
    expect(usageFrom(null)).toEqual({
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
    });
  });

  it("fills in missing or nonsensical fields with zero", () => {
    expect(
      usageFrom({
        prompt_tokens: Number.NaN,
        prompt_tokens_details: null,
      }),
    ).toEqual({
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
    });
  });

  it("clamps cached tokens to the prompt size", () => {
    expect(
      usageFrom({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 99 },
      }),
    ).toMatchObject({ promptTokens: 10, cachedPromptTokens: 10 });
  });
});

describe("formatCostUsd", () => {
  it("always writes six decimals, as the column expects", () => {
    expect(formatCostUsd(0)).toBe("0.000000");
    expect(formatCostUsd(1.5)).toBe("1.500000");
  });
});
