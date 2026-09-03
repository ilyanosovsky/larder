/**
 * One pointer drag's displacement and recent-window velocity — the same
 * reduced shape `src/lib/pantry/swipe-commit.ts` takes, deliberately kept
 * identical rather than imported: see this module's own doc comment below
 * for why the two are siblings, not one shared function.
 */
export interface StepSwipeGesture {
  readonly dx: number;
  readonly dy: number;
  readonly recentDx: number;
  readonly recentElapsedMs: number;
}

export type StepSwipeCommit = "next" | "prev" | null;

/**
 * Step navigation for S9's horizontal swipe (DESIGN_BRIEF S9, task 4.7's own
 * addendum) — a sibling of `src/lib/pantry/swipe-commit.ts`'s
 * `decideSwipeCommit`, not a reuse of it. The two are mechanically the same
 * gesture math (a 96px total-distance floor, or a 24px/0.5px-per-ms fling
 * measured only over the most recent ~100ms window — see
 * `revision-mode.tsx`'s own `VELOCITY_WINDOW_MS`), but `decideSwipeCommit`
 * returns `"have" | "ranOut"`, names that belong to the pantry revision
 * deck's own domain and would misdescribe a step swipe if reused as-is —
 * and generalizing that function to a shared, direction-only shape is a
 * refactor of code this task does not otherwise touch (AGENTS.md: no
 * drive-by refactors). A second small pure module, with its own tests
 * pinning the same thresholds, is the honest cost of that.
 *
 * **Direction convention: swipe left → next, swipe right → prev** — the
 * same "content advances toward the left" reading every carousel/story
 * viewer on a phone already uses, and the one the footer's own «← Назад» /
 * «Далее →» pair implies (Назад sits where a rightward swipe's content
 * comes from).
 */
export function decideStepSwipe(gesture: StepSwipeGesture): StepSwipeCommit {
  const { dx, dy, recentDx, recentElapsedMs } = gesture;
  const distance = Math.abs(dx);

  if (distance < Math.abs(dy)) {
    return null;
  }

  const recentDistance = Math.abs(recentDx);
  const velocity = recentElapsedMs > 0 ? recentDistance / recentElapsedMs : 0;
  const committedByDistance = distance >= DISTANCE_THRESHOLD_PX;
  const committedByFling =
    distance > 0 &&
    recentDistance >= FLING_MIN_DISTANCE_PX &&
    velocity >= FLING_VELOCITY_PX_PER_MS;

  if (!committedByDistance && !committedByFling) {
    return null;
  }

  return dx > 0 ? "prev" : "next";
}

const DISTANCE_THRESHOLD_PX = 96;
const FLING_MIN_DISTANCE_PX = 24;
const FLING_VELOCITY_PX_PER_MS = 0.5;
