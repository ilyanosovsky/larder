import { describe, expect, it } from "vitest";

import {
  badRequestReason,
  fallbackActions,
  importFailureCopyKey,
  importSourceOf,
  IMPORT_FAILURE_REASONS,
  type ImportSource,
} from "@/lib/recipes/import-failure";

import messages from "@/messages/ru.json";

const SOURCES: readonly ImportSource[] = ["photo", "url", "text"];

describe("badRequestReason", () => {
  it("names a reason whose first fallback fits the source", () => {
    expect(badRequestReason("url")).toBe("blockedUrl");
    expect(badRequestReason("text")).toBe("tooLarge");
    expect(badRequestReason("photo")).toBe("photoUnreadable");
    // A refused photo key: the way out is another photo, and the copy must
    // not talk about a page. The text field is offered right after.
    expect(fallbackActions(badRequestReason("photo"), "photo")).toEqual([
      "retryPhoto",
      "useText",
      "manual",
    ]);
    // A too-long paste: the field comes back first, so it can be cut down.
    expect(fallbackActions(badRequestReason("text"), "text")[0]).toBe(
      "useText",
    );
  });
});

describe("importSourceOf", () => {
  it("reads the source off what the failure salvaged", () => {
    // The panel renders from a stored partial and nothing else, so this is
    // the only place the three sources can still be told apart.
    expect(importSourceOf({ photoKey: "abc", sourceUrl: null })).toBe("photo");
    expect(
      importSourceOf({ photoKey: null, sourceUrl: "https://povar.ru/x" }),
    ).toBe("url");
    expect(importSourceOf({ photoKey: null, sourceUrl: null })).toBe("text");
  });

  it("prefers the photo when an import somehow carries both", () => {
    // «Другое фото» is only meaningful when there is a blob to discard.
    expect(
      importSourceOf({ photoKey: "abc", sourceUrl: "https://povar.ru/x" }),
    ).toBe("photo");
  });
});

describe("importFailureCopyKey", () => {
  it("has a distinct key for every reason", () => {
    const keys = IMPORT_FAILURE_REASONS.map((reason) =>
      importFailureCopyKey(reason, "photo"),
    );
    expect(new Set(keys).size).toBe(IMPORT_FAILURE_REASONS.length);
  });

  it.each(SOURCES)(
    "names a key that actually exists in the dictionary (source: %s)",
    (source) => {
      // next-intl has no type augmentation here and renders a missing key as
      // its own path, so a typo would ship «dishImport.failedTooLarge» on
      // screen and pass every other gate.
      const dictionary = messages.dishImport as Record<string, unknown>;

      for (const reason of IMPORT_FAILURE_REASONS) {
        expect(
          dictionary[importFailureCopyKey(reason, source)],
          `${reason} / ${source}`,
        ).toBeTypeOf("string");
      }
    },
  );

  it("writes «не рецепт» three different ways, one per source", () => {
    // One reason is not one sentence. «Похоже, на фото не рецепт» after a
    // pasted link is a sentence about something that never happened, and
    // «на этой странице» after a paste names a page that never existed.
    expect(importFailureCopyKey("notARecipe", "photo")).toBe(
      "failedNotARecipe",
    );
    expect(importFailureCopyKey("notARecipe", "url")).toBe(
      "failedNotARecipeSource",
    );
    expect(importFailureCopyKey("notARecipe", "text")).toBe(
      "failedNotARecipeText",
    );
  });

  it("keeps one sentence for the reasons that only happen one way", () => {
    // A page failure reads the same however it was reached; only the copy
    // that *names* the input has to branch.
    for (const reason of [
      "pageBlocked",
      "tooLarge",
      "aiUnavailable",
    ] as const) {
      const keys = SOURCES.map((source) =>
        importFailureCopyKey(reason, source),
      );
      expect(new Set(keys).size).toBe(1);
    }
  });
});

describe("fallbackActions", () => {
  it("never leaves a dead end", () => {
    // VISION's «без тупика» is only true if every failure still hands you
    // something to do.
    for (const source of SOURCES) {
      for (const reason of IMPORT_FAILURE_REASONS) {
        expect(
          fallbackActions(reason, source).length,
          `${reason} / ${source}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("always offers the manual form, last", () => {
    for (const source of SOURCES) {
      for (const reason of IMPORT_FAILURE_REASONS) {
        expect(
          fallbackActions(reason, source).at(-1),
          `${reason} / ${source}`,
        ).toBe("manual");
      }
    }
  });

  it("offers another photo when one was already uploaded", () => {
    expect(fallbackActions("photoUnreadable", "photo")).toEqual([
      "retryPhoto",
      "useText",
      "manual",
    ]);
  });

  it("offers to upload one when there is none yet", () => {
    expect(fallbackActions("notARecipe", "url")).toEqual([
      "useText",
      "usePhoto",
      "manual",
    ]);
  });

  it("never leads a failed paste with the field that just failed", () => {
    // Re-pasting the same words is the one thing already known not to work,
    // so the screenshot leads and the field stays available second.
    expect(fallbackActions("notARecipe", "text")).toEqual([
      "usePhoto",
      "useText",
      "manual",
    ]);
    expect(fallbackActions("notARecipe", "text")[0]).not.toBe("useText");
  });

  it("leads a page failure with the text field", () => {
    expect(fallbackActions("pageBlocked", "url")).toEqual([
      "useText",
      "usePhoto",
      "manual",
    ]);
  });

  it("leads a login wall with the screenshot", () => {
    // Instagram does not serve recipes to a server; a screenshot always
    // works. Ordering it first is honesty, not persuasion.
    expect(fallbackActions("loginWalled", "url")).toEqual([
      "usePhoto",
      "useText",
      "manual",
    ]);
  });

  it("offers a retry — and only a retry — when the model was unavailable", () => {
    expect(fallbackActions("aiUnavailable", "photo")).toEqual([
      "retry",
      "manual",
    ]);
  });

  it("never offers «Другое фото» when there is no photo to replace", () => {
    // The action discards a blob; with none in hand it would do nothing.
    for (const source of ["url", "text"] as const) {
      for (const reason of IMPORT_FAILURE_REASONS) {
        expect(
          fallbackActions(reason, source),
          `${reason} / ${source}`,
        ).not.toContain("retryPhoto");
      }
    }
  });

  it("lists no action twice", () => {
    for (const source of SOURCES) {
      for (const reason of IMPORT_FAILURE_REASONS) {
        const actions = fallbackActions(reason, source);
        expect(new Set(actions).size, `${reason} / ${source}`).toBe(
          actions.length,
        );
      }
    }
  });
});
