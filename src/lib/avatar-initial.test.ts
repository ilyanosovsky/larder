import { describe, expect, it } from "vitest";

import { avatarInitial } from "./avatar-initial";

describe("avatarInitial", () => {
  it("takes the first letter, upper-cased", () => {
    expect(avatarInitial("Кира")).toBe("К");
  });

  it("upper-cases a lower-case name", () => {
    expect(avatarInitial("аня")).toBe("А");
  });

  it("trims surrounding whitespace before taking a letter", () => {
    expect(avatarInitial("  Илья")).toBe("И");
  });

  it("falls back to a question mark for an empty name", () => {
    expect(avatarInitial("")).toBe("?");
  });

  it("falls back to a question mark for a whitespace-only name", () => {
    expect(avatarInitial("   ")).toBe("?");
  });

  it("keeps a surrogate-pair emoji whole rather than cutting it in half", () => {
    // U+1F431 (CAT FACE) is two UTF-16 code units; `.charAt(0)` would return
    // a lone, broken surrogate instead of the full glyph.
    expect(avatarInitial("🐱 Кошка")).toBe("🐱");
  });
});
