/**
 * The model every cheap, structured call uses: parsing, normalization, icon
 * and department picking (VISION §6.5). The assistant and the week-menu
 * generator may pick something bigger later; they will declare it themselves
 * rather than widening this constant.
 */
export const AI_MODEL = "gpt-5-mini";

/**
 * USD per 1,000,000 tokens. OpenAI pricing as of 2026-08, update when it
 * changes — nothing reads these numbers from the API, so a price change lands
 * here or `AiJob.costUsd` quietly starts lying.
 */
export const AI_PRICE_PER_MTOK = {
  input: 0.25,
  cachedInput: 0.025,
  output: 2.0,
} as const;

const TOKENS_PER_MTOK = 1_000_000;

/** `numeric(10, 6)` in `ai_jobs.cost_usd` — six decimals, no more. */
export const COST_DECIMALS = 6;

/**
 * The token counts a completion reports, reduced to what pricing needs.
 * `cachedPromptTokens` is a *subset* of `promptTokens`, exactly as OpenAI
 * reports it (`prompt_tokens_details.cached_tokens`).
 */
export interface AiUsage {
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly completionTokens: number;
}

/** The slice of the SDK's `CompletionUsage` this needs — kept structural so
 *  a test can build one without importing the OpenAI types. */
export interface CompletionUsageLike {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
}

/**
 * Reads usage off a completion, defensively: a response that omits the block
 * entirely (or any field in it) must produce a zero-cost job, never a crash
 * or a NaN written into `numeric`.
 */
export function usageFrom(
  usage: CompletionUsageLike | null | undefined,
): AiUsage {
  const promptTokens = finite(usage?.prompt_tokens);
  const cached = finite(usage?.prompt_tokens_details?.cached_tokens);

  return {
    promptTokens,
    // Clamped: a cached count larger than the prompt itself would otherwise
    // price part of the request at a negative rate.
    cachedPromptTokens: Math.min(cached, promptTokens),
    completionTokens: finite(usage?.completion_tokens),
  };
}

/**
 * What a call cost, in USD.
 *
 * Reasoning tokens need no special case: OpenAI bills them as output tokens
 * and already counts them inside `completion_tokens` — which is precisely why
 * every cheap call sets `reasoning_effort: "low"` (VISION §6.5), or invisible
 * reasoning turns a $0.0002 icon lookup into $0.001.
 *
 * Rounded to six decimals to match the `numeric(10, 6)` column: a value with
 * more precision would be rounded by Postgres anyway, and rounding here keeps
 * what a test asserts identical to what is stored.
 */
export function computeCostUsd(usage: AiUsage): number {
  const cached = Math.min(
    Math.max(usage.cachedPromptTokens, 0),
    Math.max(usage.promptTokens, 0),
  );
  const uncached = Math.max(usage.promptTokens, 0) - cached;

  const dollars =
    (uncached * AI_PRICE_PER_MTOK.input +
      cached * AI_PRICE_PER_MTOK.cachedInput +
      Math.max(usage.completionTokens, 0) * AI_PRICE_PER_MTOK.output) /
    TOKENS_PER_MTOK;

  const factor = 10 ** COST_DECIMALS;
  return Math.round(dollars * factor) / factor;
}

/** Drizzle's `numeric` column takes a string; this is the only formatter. */
export function formatCostUsd(costUsd: number): string {
  return costUsd.toFixed(COST_DECIMALS);
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
