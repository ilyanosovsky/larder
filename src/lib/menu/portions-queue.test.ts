import { describe, expect, it } from "vitest";

import { portionsRange } from "@/lib/recipes/rescale";

import {
  createWriteQueue,
  forgetWrite,
  queueWrite,
  settleWrite,
  stepPortions,
  tapPortions,
  type WriteQueue,
} from "./portions-queue";

/** The bounds a recipe stating four portions gives the card. */
const BOUNDS = portionsRange(4);
const ITEM = "item-1";
const OTHER = "item-2";

/**
 * Drives one card's run of taps against a fake wire, so a test reads as the
 * sequence a finger produces rather than as six calls in the right order.
 *
 * `sent` is every dispatch in order — the assertion most of these tests are
 * really about, since the whole point of the ledger is how many there are.
 */
function runner(bounds = BOUNDS) {
  const queue = createWriteQueue<number>();
  const sent: number[] = [];
  let shown = 4;

  return {
    queue,
    sent,
    get shown() {
      return shown;
    },
    tap(delta: number, id = ITEM) {
      const decision = tapPortions(queue, id, shown, delta, bounds);
      if (decision.patch !== null) {
        shown = decision.patch;
      }
      if (decision.send !== null) {
        sent.push(decision.send);
      }
      return decision;
    },
    /** The server answers the oldest outstanding write. */
    settle(value: number, ok = true, id = ITEM) {
      const decision = settleWrite(queue, id, value, ok);
      if (decision.rollbackTo !== null) {
        shown = decision.rollbackTo;
      }
      if (decision.send !== null) {
        sent.push(decision.send);
      }
      return decision;
    },
  };
}

function isEmpty(queue: WriteQueue<unknown>): boolean {
  return (
    queue.asked.size === 0 &&
    queue.inFlight.size === 0 &&
    queue.baseline.size === 0
  );
}

describe("stepPortions", () => {
  it("steps by one inside the range", () => {
    expect(stepPortions(4, 1, BOUNDS)).toBe(5);
    expect(stepPortions(4, -1, BOUNDS)).toBe(3);
  });

  it("refuses a tap at either bound rather than clamping to it", () => {
    // Both buttons are `aria-disabled` there, and a clamp would make them
    // silent no-ops that still opened a run and wrote.
    expect(stepPortions(BOUNDS.min, -1, BOUNDS)).toBeNull();
    expect(stepPortions(BOUNDS.max, 1, BOUNDS)).toBeNull();
    expect(stepPortions(BOUNDS.min, 1, BOUNDS)).toBe(BOUNDS.min + 1);
    expect(stepPortions(BOUNDS.max, -1, BOUNDS)).toBe(BOUNDS.max - 1);
  });

  it("refuses «+» on a row stored above its range, and never lowers it", () => {
    // `portions = 20` under `portionsBase = 4` (range 1…12) is reachable and
    // persistent: a partner lowering the recipe's yield does not touch
    // `menu_items`, and the server deliberately does not re-clamp. A plain
    // clamp would answer 12 here — «+» silently removing eight portions.
    expect(BOUNDS.max).toBe(12);
    expect(stepPortions(20, 1, BOUNDS)).toBeNull();
  });

  it("walks a row stored above its range back one step at a time", () => {
    // Not a jump to 12: one tap must not discard eight portions of shopping.
    expect(stepPortions(20, -1, BOUNDS)).toBe(19);
    expect(stepPortions(13, -1, BOUNDS)).toBe(12);
    expect(stepPortions(12, -1, BOUNDS)).toBe(11);
  });
});

describe("the ± ledger", () => {
  it("writes the first tap of a run immediately — no timer", () => {
    const run = runner();

    run.tap(1);

    expect(run.sent).toEqual([5]);
    expect(run.shown).toBe(5);
  });

  it("sends nothing while a write for that row is in flight", () => {
    const run = runner();

    run.tap(1);
    const second = run.tap(1);

    expect(second.send).toBeNull();
    // The number still moves under the finger.
    expect(second.patch).toBe(6);
    expect(run.shown).toBe(6);
    expect(run.sent).toEqual([5]);
  });

  it("turns a burst of five taps into exactly two writes, the second final", () => {
    const run = runner();

    for (let tap = 0; tap < 5; tap += 1) {
      run.tap(1);
    }
    expect(run.shown).toBe(9);
    expect(run.sent).toEqual([5]);

    // The first write lands; the four taps behind it are owed one follow-up.
    run.settle(5);
    expect(run.sent).toEqual([5, 9]);

    const last = run.settle(9);
    expect(last).toEqual({ rollbackTo: null, send: null, done: true });
    expect(run.sent).toEqual([5, 9]);
    expect(isEmpty(run.queue)).toBe(true);
  });

  it("ends the chain when the follow-up equals what just landed", () => {
    const run = runner();

    run.tap(1);
    run.settle(5);

    // No further tap arrived, so `asked === sent` and the run is over rather
    // than looping on itself.
    expect(run.sent).toEqual([5]);
    expect(isEmpty(run.queue)).toBe(true);
  });

  it("rolls a failed run back to the number the card showed before it", () => {
    const run = runner();

    run.tap(1);
    run.tap(1);
    expect(run.shown).toBe(6);

    run.settle(5, false);

    // Not 5 — the value before the *first* tap of the run, because the second
    // tap was never acknowledged either.
    expect(run.shown).toBe(4);
    expect(run.sent).toEqual([5]);
    expect(isEmpty(run.queue)).toBe(true);
  });

  it("rolls back to the acknowledged value, not past it, when a follow-up fails", () => {
    const run = runner();

    run.tap(1);
    run.tap(1);
    // The first write lands, so the follow-up carrying 6 goes out — inside
    // the same run, on a baseline that opened at 4.
    run.settle(5);
    expect(run.sent).toEqual([5, 6]);

    run.settle(6, false);

    // The server is holding 5; rolling back to 4 would show a number nobody
    // has — and on a dropped connection the invalidating refetch cannot
    // correct it either.
    expect(run.shown).toBe(5);
    expect(isEmpty(run.queue)).toBe(true);
  });

  it("keeps two cards' runs out of each other's ledgers", () => {
    const queue = createWriteQueue<number>();

    expect(tapPortions(queue, ITEM, 4, 1, BOUNDS)).toEqual({
      patch: 5,
      send: 5,
    });
    expect(tapPortions(queue, OTHER, 8, -1, BOUNDS)).toEqual({
      patch: 7,
      send: 7,
    });

    // Neither card is blocked by the other's outstanding write, and the
    // failure of one rolls back only its own row.
    expect(settleWrite(queue, ITEM, 5, false).rollbackTo).toBe(4);
    expect(queue.baseline.get(OTHER)).toBe(8);
    expect(settleWrite(queue, OTHER, 7, false).rollbackTo).toBe(8);
  });

  it("drops a tap at the bounds without opening a run", () => {
    const queue = createWriteQueue<number>();

    expect(tapPortions(queue, ITEM, BOUNDS.max, 1, BOUNDS)).toEqual({
      patch: null,
      send: null,
    });

    // No baseline recorded, so a later genuine run still rolls back to the
    // number the card showed when *it* began.
    expect(isEmpty(queue)).toBe(true);
  });

  it("reads the run's own intent rather than the rendered number", () => {
    const queue = createWriteQueue<number>();

    queueWrite(queue, ITEM, 4, 5);
    // A cancelled refetch restored the server's older number underneath the
    // optimistic patch; the next tap must still step from 5, not from 4.
    expect(tapPortions(queue, ITEM, 4, 1, BOUNDS).patch).toBe(6);
  });

  it("forgets a row on demand, leaving the others alone", () => {
    const queue = createWriteQueue<number>();

    queueWrite(queue, ITEM, 4, 5);
    queueWrite(queue, OTHER, 4, 5);
    forgetWrite(queue, ITEM);

    expect(queue.asked.has(ITEM)).toBe(false);
    expect(queue.asked.get(OTHER)).toBe(5);
  });
});

describe("the «приготовлено» ledger", () => {
  it("ends a tick/untick inside one round trip on the untick", () => {
    // Two unguarded writes would race, and `menu.setCooked` carries no
    // expected-state predicate — so the earlier intent could commit last and
    // the refetch would re-tick the box the user just cleared.
    const queue = createWriteQueue<boolean>();

    const tick = queueWrite(queue, ITEM, false, true);
    expect(tick).toEqual({ patch: true, send: true });

    const untick = queueWrite(queue, ITEM, true, false);
    expect(untick).toEqual({ patch: false, send: null });

    const first = settleWrite(queue, ITEM, true, true);
    expect(first).toEqual({ rollbackTo: null, send: false, done: false });

    const second = settleWrite(queue, ITEM, false, true);
    expect(second).toEqual({ rollbackTo: null, send: null, done: true });
    expect(isEmpty(queue)).toBe(true);
  });

  it("rolls a failed tick back to the state before the run", () => {
    const queue = createWriteQueue<boolean>();

    queueWrite(queue, ITEM, false, true);

    expect(settleWrite(queue, ITEM, true, false)).toEqual({
      rollbackTo: false,
      send: null,
      done: true,
    });
  });
});
