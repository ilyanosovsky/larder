import { describe, expect, it } from "vitest";

import { pickImportFocusTarget } from "./import-focus";

describe("pickImportFocusTarget", () => {
  it("follows the deep link on a fresh mount", () => {
    for (const source of ["photo", "url", "text"] as const) {
      expect(
        pickImportFocusTarget({
          refocusPicker: false,
          refocusPane: null,
          requested: source,
        }),
      ).toBe(source);
    }
  });

  it("focuses nothing without a link, or with a junk one", () => {
    // A `?src=` nobody wrote must not become a focus grab on page load.
    for (const requested of [null, "", "instagram", "PHOTO", " url"]) {
      expect(
        pickImportFocusTarget({
          refocusPicker: false,
          refocusPane: null,
          requested,
        }),
      ).toBeNull();
    }
  });

  it("lets a refusal outrank the link — the bug that shipped once", () => {
    // `?src=text`, the person used the URL pane instead, and the server
    // rate-limited it: focus belongs on the URL field with its text in it,
    // not on the empty textarea the link happened to name.
    expect(
      pickImportFocusTarget({
        refocusPicker: false,
        refocusPane: "url",
        requested: "text",
      }),
    ).toBe("url");
    expect(
      pickImportFocusTarget({
        refocusPicker: false,
        refocusPane: "text",
        requested: "url",
      }),
    ).toBe("text");
    // `?src=url` plus a refused photo run: the picker, not the URL field.
    expect(
      pickImportFocusTarget({
        refocusPicker: true,
        refocusPane: null,
        requested: "url",
      }),
    ).toBe("photo");
  });

  it("never names two controls", () => {
    // The single-valued shape is the invariant; a mutant returning to
    // per-control booleans cannot type-check against this signature.
    const targets = new Set<string | null>();
    for (const refocusPicker of [false, true]) {
      for (const refocusPane of ["url", "text", null] as const) {
        for (const requested of ["photo", "url", "text", null]) {
          targets.add(
            pickImportFocusTarget({ refocusPicker, refocusPane, requested }),
          );
        }
      }
    }
    expect([...targets].sort()).toEqual(["photo", "text", "url", null].sort());
  });
});
