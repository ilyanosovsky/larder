/**
 * What S8.1's two typed sources will accept, checked on the client *and* on
 * the server from the same module.
 *
 * Client-side too, because the useful answer to «povar.ru/recepty» pasted
 * without a scheme is a line under the field the person is looking at — not a
 * spinner followed by a 400. The server's rules still decide anything that
 * matters: `fromUrlInput` refuses a URL pointing inside the network whatever
 * this thinks of it (`src/server/recipes/url-guard.ts`), and `fromTextInput`
 * re-checks the length. This is a courtesy, not a gate.
 *
 * It lives here rather than in `import-screen.tsx` for two reasons: the
 * failure panel needs the text rule too (and importing it from the screen
 * that renders the panel would be a cycle), and a rule in a `.tsx` is a rule
 * vitest cannot reach — there is no DOM harness in this repo.
 */

/**
 * Shortest pasted text worth an AI call, in characters. Below this it is a
 * dish name, not a recipe, and the model would invent the rest.
 *
 * `fromTextInput` is built from this constant, so the client's refusal and
 * the server's cannot drift apart.
 */
export const MIN_IMPORT_TEXT = 20;

/** Longest, matching `fromTextInput` — a novel is not a recipe either. */
export const MAX_IMPORT_TEXT = 20_000;

/**
 * Does this look like a link at all?
 *
 * Deliberately shallow — scheme, a host with a dot in it, nothing more. The
 * real decision is `classifyImportUrl`'s, and duplicating any part of its
 * blocklist here would mean two lists to keep in step for no gain: a URL this
 * accepts and the server refuses still lands on S8.2's `blockedUrl` copy.
 */
export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s/]/i.test(value.trim());
}

/** Enough pasted text to be worth sending. */
export function isLongEnough(value: string): boolean {
  return value.trim().length >= MIN_IMPORT_TEXT;
}

/**
 * Past what the server will take.
 *
 * Checked on the client because the server's refusal is a `BAD_REQUEST` the
 * import screen can only report as «Сейчас не получается разобрать» — whose
 * one offer, «Ещё раз», replays the identical too-long string and fails
 * identically every time, with the textarea already unmounted so it cannot be
 * shortened. Refusing in the field, where the text still is, is the only
 * place the person can act on it.
 */
export function isTooLong(value: string): boolean {
  return value.trim().length > MAX_IMPORT_TEXT;
}

/** Both bounds at once — what the two textareas gate their submit on. */
export function isWithinTextBounds(value: string): boolean {
  return isLongEnough(value) && !isTooLong(value);
}
