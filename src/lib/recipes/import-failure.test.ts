import { describe, expect, it } from "vitest";

import {
  fallbackActions,
  importFailureCopyKey,
  IMPORT_FAILURE_REASONS,
} from "@/lib/recipes/import-failure";

import messages from "@/messages/ru.json";

describe("importFailureCopyKey", () => {
  it("has a distinct key for every reason", () => {
    const keys = IMPORT_FAILURE_REASONS.map((reason) =>
      importFailureCopyKey(reason, { hasPhoto: true }),
    );
    expect(new Set(keys).size).toBe(IMPORT_FAILURE_REASONS.length);
  });

  it.each([true, false])(
    "names a key that actually exists in the dictionary (hasPhoto: %s)",
    (hasPhoto) => {
      // next-intl has no type augmentation here and renders a missing key as
      // its own path, so a typo would ship «dishImport.failedTooLarge» on
      // screen and pass every other gate.
      const dictionary = messages.dishImport as Record<string, unknown>;

      for (const reason of IMPORT_FAILURE_REASONS) {
        expect(
          dictionary[importFailureCopyKey(reason, { hasPhoto })],
          reason,
        ).toBeTypeOf("string");
      }
    },
  );

  it("says «на фото не рецепт» only when there is a photo", () => {
    // The same reason reaches S8.2 from a screenshot and from a link, and
    // «Похоже, на фото не рецепт» after a pasted URL is a sentence about
    // something that never happened.
    expect(importFailureCopyKey("notARecipe", { hasPhoto: true })).toBe(
      "failedNotARecipe",
    );
    expect(importFailureCopyKey("notARecipe", { hasPhoto: false })).toBe(
      "failedNotARecipeSource",
    );
  });

  it("defaults to the source wording — a page import carries no photo", () => {
    expect(importFailureCopyKey("notARecipe")).toBe("failedNotARecipeSource");
  });
});

describe("fallbackActions", () => {
  it("never leaves a dead end", () => {
    // VISION's «без тупика» is only true if every failure still hands you
    // something to do.
    for (const reason of IMPORT_FAILURE_REASONS) {
      expect(fallbackActions(reason).length, reason).toBeGreaterThan(0);
    }
  });

  it("always offers the manual form, last", () => {
    for (const reason of IMPORT_FAILURE_REASONS) {
      expect(fallbackActions(reason).at(-1), reason).toBe("manual");
    }
  });

  it("offers another photo when one was already uploaded", () => {
    expect(fallbackActions("photoUnreadable", { hasPhoto: true })).toEqual([
      "retryPhoto",
      "useText",
      "manual",
    ]);
  });

  it("offers to upload one when there is none yet", () => {
    expect(fallbackActions("notARecipe", { hasPhoto: false })).toEqual([
      "usePhoto",
      "useText",
      "manual",
    ]);
  });

  it("leads a page failure with the text field", () => {
    expect(fallbackActions("pageBlocked")).toEqual([
      "useText",
      "usePhoto",
      "manual",
    ]);
  });

  it("leads a login wall with the screenshot", () => {
    // Instagram does not serve recipes to a server; a screenshot always
    // works. Ordering it first is honesty, not persuasion.
    expect(fallbackActions("loginWalled")).toEqual([
      "usePhoto",
      "useText",
      "manual",
    ]);
  });

  it("offers a retry — and only a retry — when the model was unavailable", () => {
    expect(fallbackActions("aiUnavailable", { hasPhoto: true })).toEqual([
      "retry",
      "manual",
    ]);
  });

  it("lists no action twice", () => {
    for (const reason of IMPORT_FAILURE_REASONS) {
      const actions = fallbackActions(reason, { hasPhoto: true });
      expect(new Set(actions).size, reason).toBe(actions.length);
    }
  });
});
