import { describe, expect, it } from "vitest";

import { resolveEquipmentEntry } from "./equipment-entry";

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
