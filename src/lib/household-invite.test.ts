import { describe, expect, it } from "vitest";

import { isCallerMember, isShareCancelled } from "./household-invite";

describe("isCallerMember", () => {
  it("is true for the caller's own row", () => {
    expect(
      isCallerMember({ userId: "user_1", name: "Аня", image: null }, "user_1"),
    ).toBe(true);
  });

  it("is false for a different member's row", () => {
    expect(
      isCallerMember({ userId: "user_2", name: "Илья", image: null }, "user_1"),
    ).toBe(false);
  });
});

describe("isShareCancelled", () => {
  it("is true for an AbortError", () => {
    const error = Object.assign(new Error("cancelled"), {
      name: "AbortError",
    });

    expect(isShareCancelled(error)).toBe(true);
  });

  it("is true for a DOMException-shaped object without relying on the class", () => {
    // The `node` vitest environment has no `DOMException` global — the real
    // objects `navigator.share()` rejects with are matched by shape.
    expect(isShareCancelled({ name: "AbortError", message: "" })).toBe(true);
  });

  it("is true for InvalidStateError — a share already in progress, not a failure", () => {
    // Review round 2, G4: a share overlapping an earlier one (a race the
    // ref lock in household-section.tsx is meant to prevent, but the W3C
    // rejection is not scoped to calls this component itself made) must not
    // read as "не получилось поделиться" over a share that is, from the
    // person's point of view, already working.
    const error = Object.assign(new Error("already sharing"), {
      name: "InvalidStateError",
    });

    expect(isShareCancelled(error)).toBe(true);
  });

  it("is false for any other error", () => {
    expect(isShareCancelled(new TypeError("nope"))).toBe(false);
    expect(isShareCancelled(new Error("network"))).toBe(false);
    expect(isShareCancelled({ name: "NotAllowedError" })).toBe(false);
  });

  it("is false for a value with no name at all", () => {
    expect(isShareCancelled(null)).toBe(false);
    expect(isShareCancelled(undefined)).toBe(false);
    expect(isShareCancelled("AbortError")).toBe(false);
    expect(isShareCancelled({})).toBe(false);
  });
});
