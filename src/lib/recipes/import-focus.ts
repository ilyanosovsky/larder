import type { ImportSource } from "@/lib/recipes/import-failure";

/**
 * Which of S8.1's three controls claims `autoFocus` when the source view
 * mounts — **exactly one, or none.**
 *
 * The three props used to OR the `?src=` deep link with the refusal state
 * independently, so a rate-limit refusal on one pane while `?src=` named
 * another mounted two nodes with `autoFocus` true; React commits them in
 * document order, so the later one won, and focus left the field whose text
 * had just been refused. The refusal outranks the link: the link says where
 * the person started, the refusal says where they are.
 *
 * Pure and here rather than inline in `import-screen.tsx`, like
 * `next-focus-target.ts` and `import-failure.ts` before it: vitest runs in
 * `node` with no DOM harness, so a rule left inside a `.tsx` is unreachable
 * from the suite — and this exact rule shipped wrong once already.
 */
export function pickImportFocusTarget(input: {
  /** «Другое фото», or a photo run the server refused. */
  readonly refocusPicker: boolean;
  /** The typed pane a refusal came from. */
  readonly refocusPane: "url" | "text" | null;
  /** The raw `?src=` query value — anything, including junk. */
  readonly requested: string | null;
}): ImportSource | null {
  if (input.refocusPicker) {
    return "photo";
  }
  if (input.refocusPane !== null) {
    return input.refocusPane;
  }
  const { requested } = input;
  return requested === "photo" || requested === "url" || requested === "text"
    ? requested
    : null;
}
