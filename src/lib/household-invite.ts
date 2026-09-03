/**
 * Pure decisions for the Settings «Дом» section (task 7.1a) — kept free of
 * React and the DOM so they are reachable from vitest (AGENTS.md: business
 * logic belongs in pure modules, not left inside a `.tsx` where the suite
 * cannot see it).
 */

/** One household member the way `household.current` returns it. */
export interface HouseholdMemberRow {
  userId: string;
  name: string;
  image: string | null;
}

/** Whether a member row is the caller's own — the «ты» marker on their row. */
export function isCallerMember(
  member: HouseholdMemberRow,
  callerId: string,
): boolean {
  return member.userId === callerId;
}

/**
 * Whether a rejected `navigator.share()` call is silent — not an error the
 * section should show — rather than a real failure that falls back to the
 * copy hint.
 *
 * Two names, both benign:
 * - `AbortError` — the person simply closed the share sheet.
 * - `InvalidStateError` — a share was already in progress. The mint button's
 *   `mintingRef` sibling for «Поделиться» (`household-section.tsx`) is meant
 *   to stop a second `navigator.share()` call from ever firing, but the W3C
 *   spec rejects this way for *any* overlapping call, including one this
 *   component did not make (another share affordance on the page, a stray
 *   double tap the ref lock has not yet armed for) — showing a failure alert
 *   over a share that is, from the person's point of view, already working
 *   would be a lie.
 *
 * Anything else (no share target installed, a payload the OS rejects, a
 * permission problem) is a genuine failure. Checked structurally rather than
 * with `instanceof DOMException`: that constructor does not exist in the
 * `node` environment this runs under in vitest, and the real objects the
 * browser throws already carry a `name`.
 */
export function isShareCancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }

  const { name } = error as { name: unknown };
  return name === "AbortError" || name === "InvalidStateError";
}
