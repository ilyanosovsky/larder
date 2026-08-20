/**
 * Rate limiting for AI endpoints (VISION §6.7), in force from the very first
 * one rather than retrofitted after a bill arrives.
 *
 * **Counted in the database, not in memory.** The window is a `count(*)` over
 * `ai_jobs` for one user, because the app runs on Vercel: two requests a
 * second apart routinely land in different instances, so an in-process
 * counter (or an LRU, or a token bucket in a module variable) would limit
 * nothing at all. `ai_jobs` already has a row per call and an index on
 * `(user_id, created_at)`, so the check is one indexed count and needs no
 * extra infrastructure.
 *
 * Per user, not per household: the limit protects against one person holding
 * the «Создать» button down, and a household is two people who should not
 * share a budget of taps.
 *
 * This is a spend/abuse guard, distinct from `AI_MONTHLY_BUDGET_USD`, which
 * caps the **assistant only** (task 6.1) and deliberately leaves icon-picking
 * and recipe import working at the cap.
 */

/** Bursty by design: the sheet is a human tapping «Создать», not a loop. */
export const AI_LIMIT_PER_MINUTE = 10;
export const AI_LIMIT_PER_DAY = 100;

export const MINUTE_WINDOW_MS = 60_000;
export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RateLimitReason = "minute" | "day";

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: RateLimitReason };

export interface RateLimitCounts {
  /** AI jobs this user started within the last minute. */
  readonly recentMinuteCount: number;
  /** AI jobs this user started within the last 24 hours. */
  readonly recentDayCount: number;
}

/**
 * Whether one more AI call may be made.
 *
 * The counts are of calls *already made*, so the comparison is `>=`: with
 * nine in the last minute the tenth is allowed, with ten it is not. The
 * minute window is checked first — it is the one a person can actually hit,
 * and "подожди минуту" is a far more useful thing to be told than "лимит на
 * сегодня".
 */
export function checkRateLimit({
  recentMinuteCount,
  recentDayCount,
}: RateLimitCounts): RateLimitDecision {
  if (recentMinuteCount >= AI_LIMIT_PER_MINUTE) {
    return { allowed: false, reason: "minute" };
  }
  if (recentDayCount >= AI_LIMIT_PER_DAY) {
    return { allowed: false, reason: "day" };
  }
  return { allowed: true };
}

/**
 * The two sliding-window starts to count from. Sliding rather than calendar
 * buckets, so nobody gets a fresh allowance by waiting for the top of the
 * minute.
 */
export function rateLimitWindows(now: Date): {
  minuteStart: Date;
  dayStart: Date;
} {
  return {
    minuteStart: new Date(now.getTime() - MINUTE_WINDOW_MS),
    dayStart: new Date(now.getTime() - DAY_WINDOW_MS),
  };
}
