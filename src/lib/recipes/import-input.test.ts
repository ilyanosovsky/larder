import { describe, expect, it } from "vitest";

import { MAX_SOURCE_URL } from "@/lib/recipes/draft";
import { fromTextInput, fromUrlInput } from "@/server/api/routers/dish-import";

import {
  isLongEnough,
  isSubmittableUrl,
  isTooLong,
  isUrlTooLong,
  isWithinTextBounds,
  looksLikeUrl,
  MAX_IMPORT_TEXT,
  MIN_IMPORT_TEXT,
} from "./import-input";

describe("isUrlTooLong / isSubmittableUrl", () => {
  const long = `https://example.com/${"щ".repeat(700)}`;
  const fits = `https://example.com/${"щ".repeat(300)}`;

  it("measures the normalized href, not the typed string", () => {
    expect(long.length).toBeLessThan(MAX_SOURCE_URL);
    expect(isUrlTooLong(long)).toBe(true);
    expect(isUrlTooLong(fits)).toBe(false);
    expect(isUrlTooLong(`  ${fits}  `)).toBe(false);
  });

  it("leaves a non-URL to looksLikeUrl", () => {
    expect(isUrlTooLong("povar.ru/recepty")).toBe(false);
    expect(isSubmittableUrl("povar.ru/recepty")).toBe(false);
  });

  it("refuses in the field exactly what fromUrlInput refuses", () => {
    // The whole point: no spinner followed by `blockedUrl` copy that blames
    // the site for a link the person could have shortened.
    expect(isSubmittableUrl(long)).toBe(false);
    expect(fromUrlInput.safeParse({ url: long }).success).toBe(false);
    expect(isSubmittableUrl(fits)).toBe(true);
    expect(fromUrlInput.safeParse({ url: fits }).success).toBe(true);
  });
});

describe("looksLikeUrl", () => {
  it.each([
    "https://eda.rambler.ru/recepty/x",
    "http://povar.ru/recipes/1.html",
    "HTTPS://POVAR.RU/x",
    "  https://povar.ru/x  ",
  ])("accepts %o", (value) => {
    expect(looksLikeUrl(value)).toBe(true);
  });

  it.each([
    ["a bare host", "povar.ru/recepty"],
    ["no host at all", "https://"],
    ["a hostless scheme", "https:///recepty"],
    ["a single-label host", "https://localhost/x"],
    ["prose", "вот рецепт борща"],
    ["empty", ""],
  ])("refuses %s", (_label, value) => {
    expect(looksLikeUrl(value)).toBe(false);
  });

  it("leaves the real decision to the server", () => {
    // Deliberately shallow: this only asks «is it link-shaped». A URL it
    // accepts and `classifyImportUrl` refuses still lands on S8.2's
    // `blockedUrl` copy, which is the honest outcome — duplicating any part
    // of the blocklist here would be two lists to keep in step for no gain.
    expect(looksLikeUrl("http://metadata.google.internal/x")).toBe(true);
  });
});

describe("isLongEnough", () => {
  it("counts trimmed characters", () => {
    expect(isLongEnough("Мука 285 г, сахар 200 г")).toBe(true);
    expect(isLongEnough("мука")).toBe(false);
    expect(isLongEnough(`${" ".repeat(50)}мука`)).toBe(false);
  });

  it("is exactly the server's own floor", () => {
    // The client refusing at a different length than the server would either
    // show a spinner before a 400 or block a text the server would take.
    expect(isLongEnough("я".repeat(MIN_IMPORT_TEXT))).toBe(true);
    expect(isLongEnough("я".repeat(MIN_IMPORT_TEXT - 1))).toBe(false);

    expect(
      fromTextInput.safeParse({ text: "я".repeat(MIN_IMPORT_TEXT) }).success,
    ).toBe(true);
    expect(
      fromTextInput.safeParse({ text: "я".repeat(MIN_IMPORT_TEXT - 1) })
        .success,
    ).toBe(false);
    expect(
      fromTextInput.safeParse({ text: "я".repeat(MAX_IMPORT_TEXT + 1) })
        .success,
    ).toBe(false);
  });
});

describe("isTooLong / isWithinTextBounds", () => {
  it("pins the ceiling exactly where the server's is", () => {
    // A `BAD_REQUEST` from the ceiling reaches S8.1 as «Сейчас не получается
    // разобрать», whose only offer replays the same too-long string forever —
    // so the client has to refuse it in the field, where it can still be cut.
    expect(isTooLong("я".repeat(MAX_IMPORT_TEXT))).toBe(false);
    expect(isTooLong("я".repeat(MAX_IMPORT_TEXT + 1))).toBe(true);

    expect(
      fromTextInput.safeParse({ text: "я".repeat(MAX_IMPORT_TEXT) }).success,
    ).toBe(true);
    expect(
      fromTextInput.safeParse({ text: "я".repeat(MAX_IMPORT_TEXT + 1) })
        .success,
    ).toBe(false);
  });

  it("accepts only what the server would accept", () => {
    expect(isWithinTextBounds("я".repeat(MIN_IMPORT_TEXT - 1))).toBe(false);
    expect(isWithinTextBounds("я".repeat(MIN_IMPORT_TEXT))).toBe(true);
    expect(isWithinTextBounds("я".repeat(MAX_IMPORT_TEXT))).toBe(true);
    expect(isWithinTextBounds("я".repeat(MAX_IMPORT_TEXT + 1))).toBe(false);
  });

  it("measures the trimmed length, as the server's `.trim()` does", () => {
    const padded = `${" ".repeat(500)}${"я".repeat(MAX_IMPORT_TEXT)}${" ".repeat(500)}`;

    expect(isWithinTextBounds(padded)).toBe(true);
    expect(fromTextInput.safeParse({ text: padded }).success).toBe(true);
  });
});
