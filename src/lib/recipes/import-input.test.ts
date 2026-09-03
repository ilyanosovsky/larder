import { describe, expect, it } from "vitest";

import { fromTextInput } from "@/server/api/routers/dish-import";

import {
  isLongEnough,
  looksLikeUrl,
  MAX_IMPORT_TEXT,
  MIN_IMPORT_TEXT,
} from "./import-input";

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

    expect(fromTextInput.safeParse({ text: "я".repeat(MIN_IMPORT_TEXT) }).success).toBe(
      true,
    );
    expect(
      fromTextInput.safeParse({ text: "я".repeat(MIN_IMPORT_TEXT - 1) }).success,
    ).toBe(false);
    expect(
      fromTextInput.safeParse({ text: "я".repeat(MAX_IMPORT_TEXT + 1) }).success,
    ).toBe(false);
  });
});
