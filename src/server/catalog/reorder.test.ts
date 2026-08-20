import { describe, expect, it } from "vitest";

import { checkReorderPermutation } from "@/server/catalog/reorder";

const EXISTING = ["a", "b", "c"];

describe("checkReorderPermutation", () => {
  it("accepts the identity order", () => {
    expect(checkReorderPermutation(["a", "b", "c"], EXISTING)).toEqual({
      ok: true,
    });
  });

  it("accepts a reordering of the same ids", () => {
    expect(checkReorderPermutation(["c", "a", "b"], EXISTING)).toEqual({
      ok: true,
    });
  });

  it("rejects a missing id", () => {
    expect(checkReorderPermutation(["a", "b"], EXISTING)).toEqual({
      ok: false,
      reason: "missingIds",
    });
  });

  it("rejects an extra, unknown id", () => {
    expect(checkReorderPermutation(["a", "b", "c", "d"], EXISTING)).toEqual({
      ok: false,
      reason: "unknownIds",
    });
  });

  it("rejects an id from a different household, even at the right count", () => {
    // Same length as EXISTING, but "d" never belongs to this household's set
    // — it must fail the same way any other unknown id would.
    expect(checkReorderPermutation(["a", "b", "d"], EXISTING)).toEqual({
      ok: false,
      reason: "unknownIds",
    });
  });

  it("rejects a duplicated id", () => {
    expect(checkReorderPermutation(["a", "a", "b"], EXISTING)).toEqual({
      ok: false,
      reason: "duplicateIds",
    });
  });

  it("rejects a duplicate even when it also makes the list too short to notice as missing", () => {
    expect(checkReorderPermutation(["a", "a"], EXISTING)).toEqual({
      ok: false,
      reason: "duplicateIds",
    });
  });

  it("accepts an empty household with an empty order", () => {
    expect(checkReorderPermutation([], [])).toEqual({ ok: true });
  });

  it("rejects a non-empty order against an empty household", () => {
    expect(checkReorderPermutation(["a"], [])).toEqual({
      ok: false,
      reason: "unknownIds",
    });
  });
});
