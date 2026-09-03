import type { AiChatClient, AiRequestOptions } from "@/server/ai/openai";
import { parseRecipe, type ParsedRecipe } from "@/server/ai/parse-recipe";
import type { ImportWarning } from "@/server/recipes/draft-from-parsed";
import {
  skeletonToHint,
  skeletonToParsedRecipe,
  type RecipeSkeleton,
} from "@/server/recipes/skeleton";

/**
 * The one normalizer every non-photo import goes through (blueprint §3.2–3.3,
 * decision D15).
 *
 * **It runs on the free JSON-LD/microdata path too, ungated.** VISION §6.4
 * says so outright («лёгкая ИИ-нормализация количеств нужна и на бесплатном
 * пути»), and the reason is Russian morphology: JSON-LD hands back «285 г
 * муки», and «муки» matches «Мука» under no string ranker this app has. A
 * skipped normalization does not save a cent so much as it fills the
 * household's product catalog with genitives that never match anything again.
 * ~$0.002 per import buys the noun.
 *
 * The free extraction goes in as a **hint the model corrects**, never as a
 * shape to echo, and the model never sees raw HTML — that is what keeps one
 * prompt family serving photo, page and pasted text alike (a fix to
 * ingredient parsing has to fix all three at once, or they drift and only one
 * stays good).
 *
 * **A normalization failure is not an import failure** when a skeleton
 * exists. Every extracted line becomes `{ rawText, name: rawText, qty: null }`
 * — an editable draft wearing amber «уточнить» chips — and the result carries
 * `normalizationFailed`. Honest degradation beats an error screen for a page
 * we had already read.
 */

export type NormalizeInput =
  /** A free extraction from a page's own structured data. */
  | { readonly kind: "skeleton"; readonly skeleton: RecipeSkeleton }
  /** FireCrawl's markdown for a page with nothing structured on it. */
  | { readonly kind: "markdown"; readonly markdown: string }
  /** S8.1's «Текстом» pane — whatever a person pasted. */
  | { readonly kind: "text"; readonly text: string };

export interface NormalizeRecipeArgs {
  readonly client: AiChatClient;
  readonly input: NormalizeInput;
  readonly options?: AiRequestOptions;
}

export interface NormalizeRecipeResult {
  /**
   * The recipe to build a draft from, or `null` when the call failed and
   * there was no extraction to stand in for it (markdown and pasted text have
   * no fallback — an unparsed wall of text is not a recipe).
   */
  readonly parsed: ParsedRecipe | null;
  /** `normalizationFailed` when the fallback above was used. */
  readonly warnings: readonly ImportWarning[];
  /** Always recorded, including on the branches that failed (AGENTS.md). */
  readonly costUsd: number;
  /** For `ai_jobs.error`; `null` when the call succeeded. */
  readonly error: string | null;
  /** S8.2's reason when `parsed` is `null`. */
  readonly reason: "aiUnavailable" | null;
}

/** Never throws — mirrors `parseRecipe`, whose failures it forwards. */
export async function normalizeRecipe({
  client,
  input,
  options,
}: NormalizeRecipeArgs): Promise<NormalizeRecipeResult> {
  const result = await parseRecipe({
    client,
    input:
      input.kind === "skeleton"
        ? { kind: "skeleton", hint: skeletonToHint(input.skeleton) }
        : {
            kind: "text",
            text: input.kind === "markdown" ? input.markdown : input.text,
          },
    options,
  });

  if (result.ok) {
    return {
      parsed: result.value,
      warnings: [],
      costUsd: result.costUsd,
      error: null,
      reason: null,
    };
  }

  if (input.kind === "skeleton") {
    return {
      parsed: skeletonToParsedRecipe(input.skeleton),
      warnings: ["normalizationFailed"],
      costUsd: result.costUsd,
      error: result.error,
      // Not a failure the user ever sees: the draft is real, only unlemmatized.
      reason: null,
    };
  }

  return {
    parsed: null,
    warnings: [],
    costUsd: result.costUsd,
    error: result.error,
    // `photoUnreadable` can never be right here — there is no photo. The
    // shared classifier already knows that (`reasonFor` only returns it on
    // the photo path), and this line is the belt to that braces.
    reason: "aiUnavailable",
  };
}
