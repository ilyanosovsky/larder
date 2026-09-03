import { describe, expect, it } from "vitest";

import {
  parseDurationMin,
  parseIsoDuration,
  parseRussianDuration,
} from "./duration";

describe("parseIsoDuration", () => {
  it.each([
    ["PT1H15M", 75],
    ["PT30M", 30],
    ["PT20M", 20],
    ["PT2H", 120],
    ["P1DT2H", 1560],
    ["PT90S", 2],
    ["pt45m", 45],
  ])("reads %s as %i minutes", (raw, minutes) => {
    expect(parseIsoDuration(raw)).toBe(minutes);
  });

  it("reads a zero duration as «not stated», not as zero", () => {
    // eda.rambler.ru emits `PT0M` for `prepTime` on most recipes. Storing a 0
    // would make S7 render «0 мин» as though somebody had measured it.
    expect(parseIsoDuration("P0D")).toBeNull();
    expect(parseIsoDuration("PT0M")).toBeNull();
    expect(parseIsoDuration("PT0S")).toBeNull();
  });

  it.each(["", "  ", "30 минут", "P", "PT", "garbage", "1H15M"])(
    "returns null for %o",
    (raw) => {
      expect(parseIsoDuration(raw)).toBeNull();
    },
  );

  it("returns null for null", () => {
    expect(parseIsoDuration(null)).toBeNull();
  });
});

describe("parseRussianDuration", () => {
  it.each([
    ["1 ч 20 мин", 80],
    ["1ч20мин", 80],
    ["30 минут", 30],
    ["45 мин.", 45],
    ["2 часа", 120],
    ["1 час", 60],
    ["3 ч", 180],
    ["Время приготовления: 25 минут", 25],
  ])("reads «%s» as %i minutes", (raw, minutes) => {
    expect(parseRussianDuration(raw)).toBe(minutes);
  });

  it("puts the hours before the minutes, not the other way round", () => {
    // Reading «1 ч 20 мин» left to right with one pattern gives 1.
    expect(parseRussianDuration("1 ч 20 мин")).toBe(80);
    expect(parseRussianDuration("20 мин 1 ч")).toBe(80);
  });

  it.each(["полтора часа", "недолго", "", "быстро"])(
    "returns null for «%s» — a word is not a number",
    (raw) => {
      expect(parseRussianDuration(raw)).toBeNull();
    },
  );
});

describe("parseDurationMin", () => {
  it("tries ISO first and Russian prose second", () => {
    expect(parseDurationMin("PT1H15M")).toBe(75);
    expect(parseDurationMin("1 ч 20 мин")).toBe(80);
    expect(parseDurationMin("что-то")).toBeNull();
    expect(parseDurationMin(null)).toBeNull();
  });
});
