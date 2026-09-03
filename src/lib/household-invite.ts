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
 * Whether a rejected `navigator.share()` call was the person simply closing
 * the share sheet, as opposed to a real failure.
 *
 * Browsers reject the share promise with a `DOMException` named `AbortError`
 * for a user-cancelled share — silent, not an error the section should show.
 * Anything else (no share target installed, a payload the OS rejects, a
 * permission problem) is a genuine failure that falls back to the copy hint.
 * Checked structurally rather than with `instanceof DOMException`: that
 * constructor does not exist in the `node` environment this runs under in
 * vitest, and the real objects the browser throws already carry a `name`.
 */
export function isShareCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}
