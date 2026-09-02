import { describe, expect, it } from "vitest";

import { missingEquipment } from "./equipment-check";

describe("missingEquipment", () => {
  it("returns nothing when the profile covers every requirement", () => {
    expect(missingEquipment(["oven"], ["oven", "kettle"])).toEqual([]);
  });

  it("names the appliance that is not in the profile", () => {
    expect(missingEquipment(["oven", "mixer"], ["oven"])).toEqual(["mixer"]);
  });

  it("accepts a free-form profile entry that names a preset", () => {
    // The exact case the brief calls out: someone typed «мультиварка» into
    // the profile's "add your own" field instead of checking the box.
    expect(missingEquipment(["multicooker"], ["мультиварка"])).toEqual([]);
  });

  it("is ё/case-insensitive on the free-form side too", () => {
    expect(missingEquipment(["grater"], ["Тёрка"])).toEqual([]);
  });

  it("treats an empty profile as covering nothing", () => {
    expect(missingEquipment(["oven", "mixer", "blender"], [])).toEqual([
      "oven",
      "mixer",
      "blender",
    ]);
  });

  it("returns an empty list for a recipe that needs no equipment", () => {
    expect(missingEquipment([], ["oven"])).toEqual([]);
    expect(missingEquipment([], [])).toEqual([]);
  });

  it("preserves the recipe's own order, not the profile's", () => {
    expect(
      missingEquipment(["mixer", "oven", "airfryer"], []),
    ).toEqual(["mixer", "oven", "airfryer"]);
  });

  it("ignores appliances the profile has that the recipe never asked for", () => {
    expect(missingEquipment(["oven"], ["oven", "airfryer", "mixer"])).toEqual(
      [],
    );
  });
});
