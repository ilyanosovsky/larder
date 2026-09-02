import { describe, expect, it } from "vitest";

import { deriveNeedsReview, isUnquantifiable } from "./needs-review";

/**
 * The DESIGN_BRIEF §5 recipe, verbatim — the whole point of the rule is that
 * exactly one of these ten rows wears the amber chip.
 */
const NYC_COOKIES = [
  { name: "Мука", qty: 285, unit: "г", isOptional: false, note: null },
  {
    name: "Кукурузный крахмал",
    qty: null,
    unit: null,
    isOptional: false,
    note: null,
  },
  { name: "Соль", qty: 0.75, unit: "ч.л.", isOptional: false, note: null },
  { name: "Разрыхлитель", qty: 0.5, unit: "ч.л.", isOptional: false, note: null },
  {
    name: "Масло сливочное",
    qty: 180,
    unit: "г",
    isOptional: false,
    note: "холодное",
  },
  { name: "Сахар белый", qty: 90, unit: "г", isOptional: false, note: null },
  {
    name: "Сахар коричневый",
    qty: 140,
    unit: "г",
    isOptional: false,
    note: null,
  },
  { name: "Яйца", qty: 2, unit: "шт", isOptional: false, note: "холодные" },
  {
    name: "Шоколад крупными кусками",
    qty: 150,
    unit: "г",
    isOptional: false,
    note: null,
  },
  {
    name: "Biscoff / нутелла",
    qty: null,
    unit: null,
    isOptional: true,
    note: "замороженные порции",
  },
] as const;

describe("isUnquantifiable", () => {
  it("is false for no note at all", () => {
    expect(isUnquantifiable(null)).toBe(false);
  });

  it("is false for a note that qualifies rather than replaces the amount", () => {
    expect(isUnquantifiable("холодное")).toBe(false);
    expect(isUnquantifiable("крупными кусками")).toBe(false);
  });

  it("recognizes the four deliberate-absence phrases", () => {
    expect(isUnquantifiable("по вкусу")).toBe(true);
    expect(isUnquantifiable("на глаз")).toBe(true);
    expect(isUnquantifiable("сколько возьмёт")).toBe(true);
    expect(isUnquantifiable("по желанию")).toBe(true);
  });

  it("matches inside a longer note, case- and ё-insensitively", () => {
    expect(isUnquantifiable("Соль По Вкусу, немного")).toBe(true);
    expect(isUnquantifiable("муки — сколько возьмет")).toBe(true);
  });
});

describe("deriveNeedsReview", () => {
  it("never flags a row that states a quantity, whatever the note says", () => {
    expect(
      deriveNeedsReview({
        qty: 285,
        unit: "г",
        isOptional: false,
        note: "по вкусу",
      }),
    ).toBe(false);
  });

  it("does not flag a quantity whose unit the app has no word for", () => {
    // «2 зубчика» → qty 2, unit null, the raw measure preserved in the note.
    // The amount is there; only the unit is unmapped.
    expect(
      deriveNeedsReview({
        qty: 2,
        unit: null,
        isOptional: false,
        note: "зубчик",
      }),
    ).toBe(false);
  });

  it("does not flag an optional ingredient with no quantity", () => {
    expect(
      deriveNeedsReview({
        qty: null,
        unit: null,
        isOptional: true,
        note: null,
      }),
    ).toBe(false);
  });

  it("does not flag a deliberate «по вкусу»", () => {
    expect(
      deriveNeedsReview({
        qty: null,
        unit: null,
        isOptional: false,
        note: "по вкусу",
      }),
    ).toBe(false);
  });

  it("flags a missing quantity the recipe did not mean to leave open", () => {
    expect(
      deriveNeedsReview({
        qty: null,
        unit: null,
        isOptional: false,
        note: null,
      }),
    ).toBe(true);
  });

  it("flags a row with a unit but no number — a half-read line", () => {
    expect(
      deriveNeedsReview({ qty: null, unit: "г", isOptional: false, note: null }),
    ).toBe(true);
  });

  it("flags exactly «Кукурузный крахмал» in the NYC Cookies list", () => {
    const flagged = NYC_COOKIES.filter((row) => deriveNeedsReview(row)).map(
      (row) => row.name,
    );

    expect(flagged).toEqual(["Кукурузный крахмал"]);
  });
});
