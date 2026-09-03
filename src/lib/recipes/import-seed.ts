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

/**
 * Where «Ещё раз» goes from a screen that owns no import mutation.
 *
 * The review route can only *route*, so a retry has to land on S8.1 with the
 * same source selected — and, for a link, with the link already in the field.
 * Sending every retry to `?src=photo` (which is what it used to do) answers a
 * failed page import by asking for a screenshot: not wrong exactly, but not
 * the thing the button says, and it silently drops the URL the server had
 * salvaged.
 */
export function retryImportHref(partial: ImportSeedPartial): string {
  if (partial.photoKey !== null) {
    return "/dishes/import?src=photo";
  }
  if (partial.sourceUrl !== null) {
    // Prefilled, never auto-submitted: the person taps «Разобрать» again, and
    // the server's own guards run exactly as they did the first time.
    return `/dishes/import?src=url&url=${encodeURIComponent(partial.sourceUrl)}`;
  }
  return "/dishes/import?src=text";
}
