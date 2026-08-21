import { describe, expect, it } from "vitest";

import { markOwnChange, withoutOwnChanges } from "@/lib/cart/own-changes";

const TTL = 4000;

describe("markOwnChange", () => {
  it("marks a row until now + ttl", () => {
    const marks = new Map<string, number>();

    markOwnChange(marks, "a", 1000, TTL);

    expect(marks.get("a")).toBe(5000);
  });

  it("re-marking a row extends it rather than keeping the old expiry", () => {
    const marks = new Map<string, number>();

    markOwnChange(marks, "a", 1000, TTL);
    markOwnChange(marks, "a", 3000, TTL);

    expect(marks.get("a")).toBe(7000);
  });

  it("drops marks that have already expired", () => {
    // Otherwise the map grows by one entry per tap for the whole trip.
    const marks = new Map<string, number>();

    markOwnChange(marks, "old", 0, TTL);
    markOwnChange(marks, "new", 9000, TTL);

    expect([...marks.keys()]).toEqual(["new"]);
  });

  it("keeps marks that are still live", () => {
    const marks = new Map<string, number>();

    markOwnChange(marks, "a", 1000, TTL);
    markOwnChange(marks, "b", 2000, TTL);

    expect([...marks.keys()].sort()).toEqual(["a", "b"]);
  });
});

describe("withoutOwnChanges", () => {
  it("drops a row this client changed itself", () => {
    const marks = new Map([["mine", 5000]]);

    const visible = withoutOwnChanges(new Set(["mine", "theirs"]), marks, 1000);

    expect([...visible]).toEqual(["theirs"]);
  });

  it("keeps a row once the mark has expired", () => {
    // A partner touching the same row later must still light it up.
    const marks = new Map([["mine", 5000]]);

    const visible = withoutOwnChanges(new Set(["mine"]), marks, 5000);

    expect([...visible]).toEqual(["mine"]);
  });

  it("returns the same set when nothing is suppressed", () => {
    // The common case by far — a fresh Set every render would be churn.
    const changed = new Set(["theirs"]);

    expect(withoutOwnChanges(changed, new Map([["mine", 5000]]), 1000)).toBe(
      changed,
    );
  });

  it("returns the same set when there are no marks at all", () => {
    const changed = new Set(["theirs"]);

    expect(withoutOwnChanges(changed, new Map(), 1000)).toBe(changed);
  });

  it("handles an empty diff", () => {
    const changed = new Set<string>();

    expect(withoutOwnChanges(changed, new Map([["mine", 5000]]), 1000)).toBe(
      changed,
    );
  });

  it("does not mutate the set it was handed", () => {
    const changed = new Set(["mine", "theirs"]);

    withoutOwnChanges(changed, new Map([["mine", 5000]]), 1000);

    expect([...changed].sort()).toEqual(["mine", "theirs"]);
  });

  it("suppresses every marked row in one pass", () => {
    const marks = new Map([
      ["a", 5000],
      ["b", 5000],
    ]);

    const visible = withoutOwnChanges(new Set(["a", "b", "c"]), marks, 1000);

    expect([...visible]).toEqual(["c"]);
  });
});

/**
 * The offline queue (task 2.4) breaks the assumption the window was sized
 * for: a tap can be dispatched now and delivered when the connection comes
 * back, minutes later. `cart-screen.tsx` therefore marks the row **twice** —
 * once in `onMutate`, once in `onSettled` — and these pin why the second one
 * is load-bearing rather than redundant.
 */
describe("a change queued offline and delivered much later", () => {
  it("is no longer suppressed by the mark made when it was tapped", () => {
    const marks = new Map<string, number>();
    markOwnChange(marks, "mine", 0, TTL);

    // The connection returns five minutes later and the write lands; the
    // invalidate that follows reports the row as changed.
    const deliveredAt = 300_000;

    expect(withoutOwnChanges(new Set(["mine"]), marks, deliveredAt)).toEqual(
      new Set(["mine"]),
    );
  });

  it("is suppressed once the row is marked again at delivery time", () => {
    const marks = new Map<string, number>();
    markOwnChange(marks, "mine", 0, TTL);

    const deliveredAt = 300_000;
    markOwnChange(marks, "mine", deliveredAt, TTL);

    // The refetch triggered by that same delivery arrives a moment later.
    expect(
      withoutOwnChanges(new Set(["mine"]), marks, deliveredAt + 200),
    ).toEqual(new Set());
  });

  it("still lets the row light up for a partner change after the new window", () => {
    const marks = new Map<string, number>();
    const deliveredAt = 300_000;
    markOwnChange(marks, "mine", deliveredAt, TTL);

    expect(
      withoutOwnChanges(new Set(["mine"]), marks, deliveredAt + TTL + 1),
    ).toEqual(new Set(["mine"]));
  });

  it("prunes the stale mark rather than letting the map grow all trip", () => {
    const marks = new Map<string, number>();
    markOwnChange(marks, "first", 0, TTL);
    markOwnChange(marks, "second", 300_000, TTL);

    expect([...marks.keys()]).toEqual(["second"]);
  });
});
