import { describe, expect, it } from "vitest";

import { resolveEquipmentEntry, withSlugChecked } from "./equipment-entry";

/** The RU labels the checklist itself renders (`kitchenProfile.equipment.*`). */
const LABELS = {
  oven: "Духовка",
  microwave: "Микроволновка",
  kettle: "Чайник",
  induction_hob: "Индукционная плита",
  blender: "Блендер",
  grater: "Тёрка",
  garlic_press: "Чеснокодавилка",
  multicooker: "Мультиварка",
  mixer: "Миксер",
  airfryer: "Аэрогриль",
  food_processor: "Кухонный комбайн",
} as const;

describe("resolveEquipmentEntry", () => {
  it("resolves a preset's exact localized label", () => {
    expect(resolveEquipmentEntry("Духовка", LABELS)).toEqual({
      kind: "preset",
      slug: "oven",
    });
  });

  it("resolves a localized label regardless of case", () => {
    expect(resolveEquipmentEntry("духовка", LABELS)).toEqual({
      kind: "preset",
      slug: "oven",
    });
  });

  it("resolves the slug text itself, regardless of case", () => {
    expect(resolveEquipmentEntry("Oven", LABELS)).toEqual({
      kind: "preset",
      slug: "oven",
    });
  });

  it("resolves surrounding whitespace around a label the same way", () => {
    expect(resolveEquipmentEntry("  Мультиварка  ", LABELS)).toEqual({
      kind: "preset",
      slug: "multicooker",
    });
  });

  it("falls back to a trimmed custom entry for anything that matches no preset", () => {
    expect(resolveEquipmentEntry("своё что-то", LABELS)).toEqual({
      kind: "custom",
      value: "своё что-то",
    });
  });

  it("trims a custom entry's surrounding whitespace", () => {
    expect(resolveEquipmentEntry("  Соковыжималка  ", LABELS)).toEqual({
      kind: "custom",
      value: "Соковыжималка",
    });
  });
});

describe("withSlugChecked", () => {
  it("appends the slug when it is not present", () => {
    expect(withSlugChecked(["kettle"], "oven")).toEqual(["kettle", "oven"]);
  });

  it("is a no-op when the slug is already present", () => {
    // Preserves order and does not duplicate — this is the "unchecking has
    // no effect on an already-checked box" half of the invariant.
    expect(withSlugChecked(["oven", "kettle"], "oven")).toEqual([
      "oven",
      "kettle",
    ]);
  });

  it("replaces a stray case-insensitive free-form duplicate with the canonical slug", () => {
    // The form-specific invariant this whole helper exists for: a chip like
    // "Oven" (typed before the checklist caught it, or before
    // `resolveEquipmentEntry` existed) must not survive alongside the
    // canonical `oven` slug — the two are the same appliance, and
    // `normalizeEquipment`'s own dedup would otherwise collide with the
    // stale entry and silently drop the freshly appended slug instead.
    expect(withSlugChecked(["kettle", "Oven"], "oven")).toEqual([
      "kettle",
      "oven",
    ]);
    expect(withSlugChecked(["OVEN"], "oven")).toEqual(["oven"]);
  });

  it("resolving a preset via its localized label and checking it ends up as the single canonical slug", () => {
    const resolved = resolveEquipmentEntry("Духовка", LABELS);
    expect(resolved.kind).toBe("preset");

    const equipment =
      resolved.kind === "preset" ? withSlugChecked([], resolved.slug) : [];
    expect(equipment).toEqual(["oven"]);
  });

  it("preserves unrelated entries, and their order, untouched", () => {
    expect(
      withSlugChecked(["blender", "Соковыжималка", "grater"], "oven"),
    ).toEqual(["blender", "Соковыжималка", "grater", "oven"]);
  });
});
