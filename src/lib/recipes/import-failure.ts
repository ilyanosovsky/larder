/**
 * What S8.2 shows when an import does not produce a recipe (blueprint §3.6).
 *
 * **A parse failure is a fork in the road, not an error.** DESIGN_BRIEF S8.2
 * spells the tone out — «без тупика, сразу поля» — and every reason below
 * therefore names at least one thing the person can do *next*, in the same
 * calm amber register the rest of the app uses for «уточнить» (never `--neg`;
 * nothing went wrong with the app).
 *
 * The switches are **exhaustive with no `default` clause**, deliberately. It
 * is what made task 4.4's six URL reasons impossible to ship without copy and
 * a way out for each; a `default` would have handed them the generic box and
 * lost the specific fallback that is the whole point of the screen.
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
 * Where the import came from — the second half of every S8.2 decision.
 *
 * A reason on its own is not enough to write a sentence with: `notARecipe`
 * reaches this screen from a screenshot, from a link and from pasted text,
 * and «Похоже, на фото не рецепт» is nonsense after two of those. It also
 * decides the *actions*: a screenshot already in hand is «Другое фото», none
 * yet is «Загрузить скриншот», and text the person just pasted must not be
 * the first thing offered back to them.
 */
export type ImportSource = "photo" | "url" | "text";

/**
 * The source, read off what a failure salvaged.
 *
 * A photo import is the only one that carries a `photoKey`, and a URL import
 * always carries its `sourceUrl` — the router puts it in the partial before
 * anything can fail. Everything else is a paste. Pure and tested here rather
 * than inline in the panel, because the panel is a `.tsx` and vitest runs in
 * `node` with no DOM harness.
 */
export function importSourceOf(partial: {
  photoKey: string | null;
  sourceUrl: string | null;
}): ImportSource {
  if (partial.photoKey !== null) {
    return "photo";
  }
  return partial.sourceUrl !== null ? "url" : "text";
}

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
  /**
   * Paste the recipe text. Rendered as an inline, focused field rather than a
   * button wherever the screen owns an import mutation (S8.1) — DESIGN_BRIEF
   * S8.2's «без тупика, сразу поля» — and as a link back to S8.1's «Текстом»
   * pane on the review route, which owns none.
   */
  | "useText"
  /** Run the same import again: for a transient AI failure only. */
  | "retry"
  /** «✍️ Вручную» — the empty form, prefilled with whatever was salvaged. */
  | "manual";

/**
 * What a `BAD_REQUEST` — input the server refuses before it opens a job row,
 * so there is no `jobId` — means per source. A URL pointing inside the
 * network is `blockedUrl` (decision C.8's validation rejection); a paste past
 * `MAX_IMPORT_TEXT` is `tooLarge`, whose fallback brings the field back so it
 * can be cut down; and a photo whose key the server refuses is not something
 * a person can fix by editing — the key was minted by the upload callback —
 * so the honest reason is the one whose first fallback is another photo, not
 * «страница слишком тяжёлая» about a page that never existed.
 */
export function badRequestReason(source: ImportSource): ImportFailureReason {
  switch (source) {
    case "url":
      return "blockedUrl";
    case "text":
      return "tooLarge";
    case "photo":
      return "photoUnreadable";
  }
}

/**
 * The `dishImport.*` key holding the sentence shown above the actions.
 *
 * Keyed on the reason **and the source**, because one reason is not one
 * sentence: `notARecipe` arrives from a screenshot, from a link and from
 * pasted text, and each deserves to be told about the thing it actually sent.
 * A boolean got two of the three right and told the third that «на этой
 * странице» — a page it never had — has no recipe on it.
 */
export function importFailureCopyKey(
  reason: ImportFailureReason,
  source: ImportSource,
): string {
  switch (reason) {
    case "photoUnreadable":
      return "failedPhotoUnreadable";
    case "notARecipe":
      switch (source) {
        case "photo":
          return "failedNotARecipe";
        case "url":
          return "failedNotARecipeSource";
        case "text":
          return "failedNotARecipeText";
      }
    // falls through — the inner switch is exhaustive and always returns
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
 * What to offer, given how the import failed and what it was fed.
 *
 * The asymmetry is the reason the source is needed at all: after a failed
 * photo import the useful offer is «Другое фото» (which also discards the
 * blob that did not work); after a failed *page* import there is no photo
 * yet, and the offer is «Загрузить скриншот» — the thing VISION §6.4 says
 * works better than the page did; and after failed *text* the field the
 * person just used must not lead, because re-pasting the same words is the
 * one thing already known not to work.
 */
export function fallbackActions(
  reason: ImportFailureReason,
  source: ImportSource,
): readonly FallbackAction[] {
  return [...primaryActions(reason, source), "manual"];
}

function primaryActions(
  reason: ImportFailureReason,
  source: ImportSource,
): readonly FallbackAction[] {
  switch (reason) {
    case "photoUnreadable":
      // DESIGN_BRIEF S8.2 verbatim: «Другое фото» · «Вставить текст».
      return source === "photo"
        ? ["retryPhoto", "useText"]
        : ["usePhoto", "useText"];
    case "notARecipe":
      switch (source) {
        case "photo":
          return ["retryPhoto", "useText"];
        case "url":
          // «На этой странице нет рецепта. Вставь текст или скриншот» — the
          // field leads, as it does for every other page failure.
          return ["useText", "usePhoto"];
        case "text":
          // The screenshot leads. Offering the textarea first would be
          // offering back the exact words that just did not work.
          return ["usePhoto", "useText"];
      }
    // falls through — the inner switch is exhaustive and always returns
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
