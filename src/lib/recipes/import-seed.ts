import { emptyDraft, type RecipeDraft } from "@/lib/recipes/draft";

/**
 * What «✍️ Вручную» starts from after an import that did not produce a draft.
 *
 * VISION's «без тупика» is only true if the dead end still hands you
 * something, and the server already salvaged it: the page's title, the
 * screenshot that was uploaded, the URL that was pasted. All three are in the
 * failed job's `partial`, and this is the one function that decides what the
 * empty form does with them.
 *
 * **The source is derived from what survived, not defaulted to «manual».** A
 * dish whose recipe was typed in by hand *after* a failed page import still
 * came from that page — S7's «Источник» link is the difference between the
 * URL being kept and being silently dropped on the floor of the screen that
 * was supposed to rescue it.
 *
 * Pure and tested here rather than inline in `new-dish-screen.tsx`, for the
 * reason `import-consumption.ts` was extracted before it: that file is a
 * `"use client"` component and vitest runs in `node` with no DOM harness, so
 * a rule left inside it cannot be checked at all.
 */
export interface ImportSeedPartial {
  readonly title: string | null;
  readonly photoUrl: string | null;
  readonly photoKey: string | null;
  readonly sourceUrl: string | null;
}

export function draftFromPartial(partial: ImportSeedPartial): RecipeDraft {
  return {
    ...emptyDraft(),
    title: partial.title ?? "",
    photoUrl: partial.photoUrl,
    photoKey: partial.photoKey,
    sourceUrl: partial.sourceUrl,
    // A photo beats a URL: a screenshot of an Instagram post is the photo
    // import it was, whatever link happened to be salvaged alongside it.
    sourceType:
      partial.photoKey !== null
        ? "photo"
        : partial.sourceUrl !== null
          ? "url"
          : "manual",
  };
}
