import { describe, expect, it } from "vitest";

import { RECIPE_UNITS } from "@/lib/units";
import { coerceRecipeUnit } from "@/server/recipes/coerce-unit";

describe("coerceRecipeUnit", () => {
  it.each([
    ["гр", "г"],
    ["г.", "г"],
    ["грамм", "г"],
    ["граммов", "г"],
    ["Г", "г"],
    ["шт.", "шт"],
    ["штук", "шт"],
    ["кг", "кг"],
    ["килограмма", "кг"],
    ["мл", "мл"],
    ["миллилитров", "мл"],
    ["л", "л"],
    ["литра", "л"],
    ["уп.", "уп"],
    ["упаковки", "уп"],
    ["пачка", "уп"],
    ["пучка", "пучок"],
    ["банок", "банка"],
    ["плитки", "плитка"],
  ])("maps «%s» to «%s»", (raw, unit) => {
    expect(coerceRecipeUnit(raw)).toEqual({ unit, leftover: null });
  });

  it.each([
    ["ч. л.", "ч.л."],
    ["ч.л", "ч.л."],
    ["ч.л.", "ч.л."],
    ["чайная ложка", "ч.л."],
    ["чайной ложки", "ч.л."],
    ["ст. ложка", "ст.л."],
    ["ст.л.", "ст.л."],
    ["столовых ложек", "ст.л."],
    ["стакана", "стакан"],
    ["стаканов", "стакан"],
    ["щепотки", "щепотка"],
  ])("maps the kitchen measure «%s» to «%s»", (raw, unit) => {
    expect(coerceRecipeUnit(raw)).toEqual({ unit, leftover: null });
  });

  it.each([
    ["ст. ложки", "ст.л."],
    ["ст. ложек", "ст.л."],
    ["столовых ложек", "ст.л."],
    ["ст.ложки", "ст.л."],
    ["ч. ложки", "ч.л."],
    ["чайных ложек", "ч.л."],
    ["чайные ложки", "ч.л."],
  ])("declines the spoon in «%s» to «%s»", (raw, unit) => {
    // A real povar.ru import missed «ст. ложки» when the table enumerated
    // spellings one by one; Russian declines both words, so the stem decides.
    expect(coerceRecipeUnit(raw)).toEqual({ unit, leftover: null });
  });

  it("keeps a bare «ложка» as a leftover — no size is named", () => {
    expect(coerceRecipeUnit("ложка")).toEqual({
      unit: null,
      leftover: "ложка",
    });
  });

  it("does not read «стакана» as a spoon", () => {
    // «ст» prefixes both «стакан» and «ст.л.»; only the `ложк` stem separates
    // them, and getting it wrong is a sixteen-fold error.
    expect(coerceRecipeUnit("стакана")).toEqual({
      unit: "стакан",
      leftover: null,
    });
  });

  it("folds ё and is case-insensitive", () => {
    expect(coerceRecipeUnit("Щёпотка")).toEqual({
      unit: "щепотка",
      leftover: null,
    });
  });

  it("keeps «зубчик» as a leftover rather than bucketing it into «шт»", () => {
    // The whole reason the model returns free text: «2 зубчика» is a complete
    // instruction, and «2 шт» of garlic is a different recipe.
    expect(coerceRecipeUnit("зубчик")).toEqual({
      unit: null,
      leftover: "зубчик",
    });
  });

  it("keeps «по вкусу» as a leftover — it is a note, not a unit", () => {
    expect(coerceRecipeUnit("по вкусу")).toEqual({
      unit: null,
      leftover: "по вкусу",
    });
  });

  it("preserves the leftover's own spelling for the note", () => {
    // The note is shown to a person, so it keeps the source's capitalization
    // rather than the normalized lookup key.
    expect(coerceRecipeUnit("  Веточка ")).toEqual({
      unit: null,
      leftover: "Веточка",
    });
  });

  it("treats an empty or blank unit as unstated, with nothing to carry", () => {
    expect(coerceRecipeUnit("")).toEqual({ unit: null, leftover: null });
    expect(coerceRecipeUnit("   ")).toEqual({ unit: null, leftover: null });
    expect(coerceRecipeUnit(null)).toEqual({ unit: null, leftover: null });
  });

  it("is a no-op on every canonical unit", () => {
    // Task 4.6 re-coerces stored units; a canon value that came back as a
    // leftover would move a real unit into the note on every adaptation.
    for (const unit of RECIPE_UNITS) {
      expect(coerceRecipeUnit(unit), unit).toEqual({ unit, leftover: null });
    }
  });

  it("does not mistake «ст» for a tablespoon", () => {
    // «ст» is the abbreviation of «стакан»; «ст.л.» is the tablespoon. Getting
    // this backwards would multiply every such quantity by about sixteen.
    expect(coerceRecipeUnit("ст")).toEqual({ unit: "стакан", leftover: null });
    expect(coerceRecipeUnit("ст.л.")).toEqual({
      unit: "ст.л.",
      leftover: null,
    });
  });
});
