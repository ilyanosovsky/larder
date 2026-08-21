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
