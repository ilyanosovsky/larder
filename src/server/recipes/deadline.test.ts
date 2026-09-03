import { describe, expect, it } from "vitest";

import {
  canRunFirecrawl,
  Deadline,
  deadlineStageMs,
  FETCH_STAGE_MS,
  FIRECRAWL_MIN_REMAINING_MS,
  FIRECRAWL_STAGE_MS,
  IMPORT_DEADLINE_MS,
  NORMALIZE_STAGE_MS,
} from "@/server/recipes/deadline";

describe("deadlineStageMs", () => {
  it("gives a stage its full share while the budget allows it", () => {
    expect(deadlineStageMs(50_000, 40_000)).toBe(40_000);
  });

  it("clamps a stage to what is actually left", () => {
    expect(deadlineStageMs(6_000, 20_000)).toBe(6_000);
  });

  it("never returns a negative delay", () => {
    // `AbortSignal.timeout(-1)` throws a RangeError, and a RangeError is not
    // a failure reason S8.2 has copy for — an exhausted budget has to abort,
    // not crash.
    expect(deadlineStageMs(-5_000, 20_000)).toBe(0);
    expect(deadlineStageMs(0, 20_000)).toBe(0);
  });

  it("treats a non-finite input as no budget rather than as infinity", () => {
    expect(deadlineStageMs(Number.NaN, 20_000)).toBe(0);
    expect(deadlineStageMs(20_000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("Deadline", () => {
  /** A clock the test moves by hand — no timers, no waiting. */
  function clock(start = 1_000_000) {
    let now = start;
    return {
      now: () => now,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it("starts with the whole budget", () => {
    const time = clock();
    const deadline = new Deadline(IMPORT_DEADLINE_MS, time.now);

    expect(deadline.remainingMs()).toBe(IMPORT_DEADLINE_MS);
    expect(deadline.expired()).toBe(false);
  });

  it("shrinks as stages consume it", () => {
    const time = clock();
    const deadline = new Deadline(50_000, time.now);

    time.advance(8_000);
    expect(deadline.remainingMs()).toBe(42_000);

    time.advance(20_000);
    expect(deadline.remainingMs()).toBe(22_000);
  });

  it("floors at zero and reports itself expired", () => {
    const time = clock();
    const deadline = new Deadline(50_000, time.now);

    time.advance(60_000);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it("caps a stage signal by what is left", () => {
    const time = clock();
    const deadline = new Deadline(50_000, time.now);

    time.advance(44_000);
    // 6 s left against a 20 s stage: the decision the FireCrawl skip in task
    // 4.4 is built on, and the reason the arithmetic is a pure function.
    expect(deadlineStageMs(deadline.remainingMs(), 20_000)).toBe(6_000);
  });

  it("hands out a real, already-armed AbortSignal", () => {
    const deadline = new Deadline(50_000);
    const signal = deadline.signal(40_000);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("hands out an immediately-aborted signal once the budget is gone", async () => {
    const time = clock();
    const deadline = new Deadline(50_000, time.now);
    time.advance(60_000);

    const signal = deadline.signal(40_000);
    // `AbortSignal.timeout(0)` fires on the next macrotask, not synchronously.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal.aborted).toBe(true);
  });
});

describe("the URL path's budget (task 4.4)", () => {
  /** A clock the test moves by hand — no timers, no waiting. */
  function clock(start = 1_000_000) {
    let now = start;
    return {
      now: () => now,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it("skips FireCrawl rather than starting a scrape it cannot finish", () => {
    // A 20 s scrape begun with six seconds left cannot return, and the AI
    // call behind it certainly cannot — so the honest move is to spend
    // nothing and hand S8.2 its `pageBlocked` copy.
    expect(canRunFirecrawl(FIRECRAWL_MIN_REMAINING_MS)).toBe(true);
    expect(canRunFirecrawl(FIRECRAWL_MIN_REMAINING_MS - 1)).toBe(false);
    expect(canRunFirecrawl(6_000)).toBe(false);
    expect(canRunFirecrawl(0)).toBe(false);
  });

  it("keeps the free path inside the budget even at its worst", () => {
    // JSON-LD costs a fetch and a normalization; that pair must always fit,
    // or the common case would be the one that 504s.
    expect(FETCH_STAGE_MS + NORMALIZE_STAGE_MS).toBeLessThan(
      IMPORT_DEADLINE_MS,
    );
  });

  it("deliberately over-books the three stages, and lets the clock arbitrate", () => {
    // 8 + 20 + 25 = 53 against a 50 s budget. That is the design: each stage
    // gets its share *capped by what is left*, so the sum being larger than
    // the whole is exactly what `Deadline` absorbs — and the alternative,
    // shrinking every stage to fit the worst case, would make the common
    // path give up early for no reason.
    expect(
      FETCH_STAGE_MS + FIRECRAWL_STAGE_MS + NORMALIZE_STAGE_MS,
    ).toBeGreaterThan(IMPORT_DEADLINE_MS);

    const time = clock();
    const deadline = new Deadline(IMPORT_DEADLINE_MS, time.now);
    time.advance(FETCH_STAGE_MS + FIRECRAWL_STAGE_MS);
    expect(deadlineStageMs(deadline.remainingMs(), NORMALIZE_STAGE_MS)).toBe(
      22_000,
    );
  });
});
