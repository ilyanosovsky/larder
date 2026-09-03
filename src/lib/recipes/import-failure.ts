/**
 * What S8.2 shows when an import does not produce a recipe (blueprint §3.6).
 *
 * **A parse failure is a fork in the road, not an error.** DESIGN_BRIEF S8.2
 * spells the tone out — «без тупика, сразу поля» — and every reason below
 * therefore names at least one thing the person can do *next*, in the same
 * calm amber register the rest of the app uses for «уточнить» (never `--neg`;
 * nothing went wrong with the app).
 *
 * The switches are **exhaustive with no `default` clause**, deliberately.
 * Task 4.4 adds URL and text reasons to `importFailureReason`, and without a
 * `default` the compiler refuses to build until S8.2 has copy and a way out
 * for each new one. A `default` would silently hand a new failure the generic
 * box and lose the specific fallback that is the whole point of the screen.
 *
 * Pure and client-safe: the copy itself lives in `dishImport.*` (next-intl);
 * this module only ever returns keys.
 */

/**
 * Every way an import can end without a draft. Declared here rather than in
 * the router so the client can exhaust it without importing server code; the
 * router's Zod enum is built from this list.
 */
export const IMPORT_FAILURE_REASONS = [
  /** Vision failed, refused, or answered something that is not a recipe. */
  "photoUnreadable",
  /** `isRecipe: false`, or an answer with neither ingredients nor steps. */
  "notARecipe",
  /** DNS/TCP/TLS/timeout, or a non-HTML content type (task 4.4). */
  "pageUnreachable",
  /** 403/429/503, or FireCrawl failed or was skipped (task 4.4). */
  "pageBlocked",
  /** Fetched fine, nothing structured on the page (task 4.4). */
  "noRecipeOnPage",
  /** instagram/facebook/tiktok — a login wall, not a failure (task 4.4). */
  "loginWalled",
  /** Refused by the SSRF guard before any fetch (task 4.4). */
  "blockedUrl",
  /** The page body ran past the cap (task 4.4). */
  "tooLarge",
  /** OpenAI threw, timed out, or truncated its own answer. */
  "aiUnavailable",
] as const;

export type ImportFailureReason = (typeof IMPORT_FAILURE_REASONS)[number];

/**
 * The ways out of a failure, in the order S8.2 renders them. The first is the
 * primary button.
 *
 * `manual` is appended to every list by `fallbackActions`, so «без тупика» is
 * a property of the function rather than of each branch remembering it.
 */
export type FallbackAction =
  /** Pick another image — discards the uploaded one first. */
  | "retryPhoto"
  /** Upload a screenshot (from a URL/text failure, where none exists yet). */
  | "usePhoto"
  /** Paste the recipe text — task 4.4 turns this into a live field. */
  | "useText"
  /** Run the same import again: for a transient AI failure only. */
  | "retry"
  /** «✍️ Вручную» — the empty form, prefilled with whatever was salvaged. */
  | "manual";

/** The `dishImport.*` key holding the sentence shown above the actions. */
export function importFailureCopyKey(reason: ImportFailureReason): string {
  switch (reason) {
    case "photoUnreadable":
      return "failedPhotoUnreadable";
    case "notARecipe":
      return "failedNotARecipe";
    case "pageUnreachable":
      return "failedPageUnreachable";
    case "pageBlocked":
      return "failedPageBlocked";
    case "noRecipeOnPage":
      return "failedNoRecipeOnPage";
    case "loginWalled":
      return "failedLoginWalled";
    case "blockedUrl":
      return "failedBlockedUrl";
    case "tooLarge":
      return "failedTooLarge";
    case "aiUnavailable":
      return "failedAiUnavailable";
  }
}

/**
 * What to offer, given how the import failed and whether a photo is already
 * in hand.
 *
 * The photo/URL asymmetry is the reason `hasPhoto` exists: after a failed
 * photo import the useful offer is «Другое фото» (which also discards the
 * blob that did not work); after a failed *page* import there is no photo
 * yet, and the offer is «Загрузить скриншот» — the thing VISION §6.4 says
 * works better than the page did.
 */
export function fallbackActions(
  reason: ImportFailureReason,
  { hasPhoto }: { hasPhoto: boolean } = { hasPhoto: false },
): readonly FallbackAction[] {
  return [...primaryActions(reason, hasPhoto), "manual"];
}

function primaryActions(
  reason: ImportFailureReason,
  hasPhoto: boolean,
): readonly FallbackAction[] {
  switch (reason) {
    case "photoUnreadable":
    case "notARecipe":
      // DESIGN_BRIEF S8.2 verbatim: «Другое фото» · «Вставить текст».
      return hasPhoto ? ["retryPhoto", "useText"] : ["usePhoto", "useText"];
    case "pageUnreachable":
    case "pageBlocked":
    case "noRecipeOnPage":
    case "blockedUrl":
    case "tooLarge":
      // «Вставь текст рецепта или скриншот — так надёжнее»: the text field is
      // focused, and the screenshot zone sits under it.
      return ["useText", "usePhoto"];
    case "loginWalled":
      // Instagram never returns a recipe to a server. A screenshot always
      // does, so it leads — that is the honest ordering, not a nudge.
      return ["usePhoto", "useText"];
    case "aiUnavailable":
      // Nothing about the input was wrong, so re-offering the input is noise;
      // the useful pair is «ещё раз» and «вручную».
      return ["retry"];
  }
}
