import { describe, expect, it } from "vitest";

import { EQUIPMENT_PRESETS, normalizeEquipment } from "./equipment";

describe("normalizeEquipment", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeEquipment(["  Соковыжималка  "])).toEqual([
      "Соковыжималка",
    ]);
  });

  it("drops entries that are empty or whitespace-only after trimming", () => {
    expect(normalizeEquipment(["oven", "", "   ", "kettle"])).toEqual([
      "oven",
      "kettle",
    ]);
  });

  it("caps a single entry at 40 characters", () => {
    const tooLong = "а".repeat(50);

    expect(normalizeEquipment([tooLong])).toEqual([tooLong.slice(0, 40)]);
  });

  it("re-trims after capping, so the cut does not leave trailing whitespace", () => {
    const withTrailingSpaceAtCut = `${"а".repeat(39)} ${"б".repeat(10)}`;

    expect(normalizeEquipment([withTrailingSpaceAtCut])).toEqual([
      "а".repeat(39),
    ]);
  });

  it("keeps every preset slug distinct — presets dedupe exactly, not loosely", () => {
    expect(normalizeEquipment([...EQUIPMENT_PRESETS])).toEqual([
      ...EQUIPMENT_PRESETS,
    ]);
  });

  it("drops an exact duplicate preset slug", () => {
    expect(normalizeEquipment(["oven", "kettle", "oven"])).toEqual([
      "oven",
      "kettle",
    ]);
  });

  it("dedupes free-form entries case-insensitively, keeping the first casing seen", () => {
    expect(
      normalizeEquipment(["Мультиварка", "мультиварка", "МУЛЬТИВАРКА"]),
    ).toEqual(["Мультиварка"]);
  });

  it("collapses a free-form entry that spells out a preset onto the preset slug", () => {
    // Typing the Russian word for an appliance that is already checked via
    // the preset checkbox must not add a second, redundant chip for it.
    expect(normalizeEquipment(["oven", "OVEN"])).toEqual(["oven"]);
  });

  it("preserves the order entries first appear in", () => {
    expect(normalizeEquipment(["kettle", "oven", "kettle"])).toEqual([
      "kettle",
      "oven",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeEquipment([])).toEqual([]);
  });
});
