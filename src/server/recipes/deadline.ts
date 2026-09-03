/**
 * One time budget threaded through a whole import (blueprint §3.4, decision
 * D17).
 *
 * `maxDuration = 60` is Vercel Hobby's ceiling for the tRPC route, and an
 * import that runs past it does not return a fallback — it returns a 504,
 * which is the one outcome S8.2 has no copy for. Independent per-stage
 * timeouts cannot prevent that: 8 s of DNS + 8 s of fetch + 25 s of AI is
 * inside every individual limit and outside the function's.
 *
 * So the stages share one shrinking budget. Task 4.3 (photo) has a single
 * stage; task 4.4 (URL) adds fetch and FireCrawl in front of it, and
 * `remainingMs()` is what lets it skip FireCrawl rather than start a 20 s
 * scrape with 6 s left.
 *
 * The clock is injectable and the arithmetic lives in a pure function, so the
 * rules are tested without fake timers or a real 50-second wait.
 */

/** Total budget: 50 s inside the route's 60 s, leaving room for the response. */
export const IMPORT_DEADLINE_MS = 50_000;

/** The vision call's share when it is the only stage (task 4.3's photo path). */
export const PHOTO_STAGE_MS = 40_000;

/**
 * The URL path's three stages (task 4.4): 8 + 20 + 25 = 53 s of *worst case*
 * inside a 50 s budget, which is the point — the stages share one shrinking
 * clock, so the sum being larger than the whole is exactly what `Deadline`
 * exists to absorb.
 */
export const FETCH_STAGE_MS = 8_000;
export const FIRECRAWL_STAGE_MS = 20_000;
export const NORMALIZE_STAGE_MS = 25_000;

/**
 * Below this, FireCrawl is not started at all.
 *
 * A scrape that begins with six seconds left cannot finish, and the AI call
 * behind it certainly cannot — so the honest move is to spend nothing and
 * return `pageBlocked`, whose S8.2 copy already offers text and a screenshot.
 * Starting it anyway would burn a credit to produce a 504.
 */
export const FIRECRAWL_MIN_REMAINING_MS = 10_000;

/** Is there room left for a scrape *and* the call that reads it? */
export function canRunFirecrawl(remainingMs: number): boolean {
  return remainingMs >= FIRECRAWL_MIN_REMAINING_MS;
}

/**
 * How long a stage may actually take: its own share, capped by what is left,
 * never negative.
 *
 * Returning `0` rather than a negative number matters — the value is handed
 * to `AbortSignal.timeout`, which rejects a negative delay, and a stage with
 * no budget must abort immediately rather than throw a `RangeError` that no
 * failure branch maps to a reason.
 */
export function deadlineStageMs(remainingMs: number, stageMs: number): number {
  if (!Number.isFinite(remainingMs) || !Number.isFinite(stageMs)) {
    return 0;
  }
  return Math.max(0, Math.min(stageMs, remainingMs));
}

export class Deadline {
  private readonly startedAt: number;

  constructor(
    private readonly totalMs: number = IMPORT_DEADLINE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Milliseconds left, floored at zero. */
  remainingMs(): number {
    return Math.max(0, this.totalMs - (this.now() - this.startedAt));
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /**
   * A signal that fires at `min(stageMs, remainingMs)`.
   *
   * `AbortSignal.timeout` (Node 22 has it natively) rather than a
   * `setTimeout` + `AbortController` pair: the timer is unref'd by the
   * platform, so an abandoned signal cannot hold the serverless function open
   * past the answer it was waiting for.
   */
  signal(stageMs: number): AbortSignal {
    return AbortSignal.timeout(deadlineStageMs(this.remainingMs(), stageMs));
  }
}
