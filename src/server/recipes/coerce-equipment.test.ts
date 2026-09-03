import { describe, expect, it } from "vitest";

import { EQUIPMENT_PRESETS } from "@/server/kitchen/equipment";

import {
  coerceEquipmentList,
  coerceEquipmentSlug,
  EQUIPMENT_WORD,
} from "./coerce-equipment";

describe("coerceEquipmentSlug", () => {
  it("maps the Russian words the brief lists", () => {
    expect(coerceEquipmentSlug("духовка")).toBe("oven");
    expect(coerceEquipmentSlug("микроволновка")).toBe("microwave");
    expect(coerceEquipmentSlug("свч")).toBe("microwave");
    expect(coerceEquipmentSlug("чайник")).toBe("kettle");
    expect(coerceEquipmentSlug("индукционная плита")).toBe("induction_hob");
    expect(coerceEquipmentSlug("плита")).toBe("induction_hob");
    expect(coerceEquipmentSlug("блендер")).toBe("blender");
    expect(coerceEquipmentSlug("тёрка")).toBe("grater");
    expect(coerceEquipmentSlug("терка")).toBe("grater");
    expect(coerceEquipmentSlug("чеснокодавилка")).toBe("garlic_press");
    expect(coerceEquipmentSlug("пресс для чеснока")).toBe("garlic_press");
    expect(coerceEquipmentSlug("мультиварка")).toBe("multicooker");
    expect(coerceEquipmentSlug("миксер")).toBe("mixer");
    expect(coerceEquipmentSlug("аэрогриль")).toBe("airfryer");
    expect(coerceEquipmentSlug("кухонный комбайн")).toBe("food_processor");
    expect(coerceEquipmentSlug("комбайн")).toBe("food_processor");
  });

  it("is ё/case/whitespace-insensitive", () => {
    expect(coerceEquipmentSlug("ДУХОВКА")).toBe("oven");
    expect(coerceEquipmentSlug("  духовка  ")).toBe("oven");
    expect(coerceEquipmentSlug("духовка")).toBe(coerceEquipmentSlug("Духовка"));
    expect(coerceEquipmentSlug("индукционная    плита")).toBe("induction_hob");
  });

  it("maps a slug to itself", () => {
    for (const slug of EQUIPMENT_PRESETS) {
      expect(coerceEquipmentSlug(slug)).toBe(slug);
      expect(coerceEquipmentSlug(slug.toUpperCase())).toBe(slug);
    }
  });

  it("drops anything it does not recognize", () => {
    expect(coerceEquipmentSlug("соковыжималка")).toBeNull();
    expect(coerceEquipmentSlug("")).toBeNull();
    expect(coerceEquipmentSlug("   ")).toBeNull();
  });

  it("matches whole strings only, never a phrase or an inflected form", () => {
    // The module doc's own contract: a sentence needs a word-boundary/stem
    // scan this function deliberately does not do (no caller hands it prose
    // today — recipe equipment arrives as a word list already split out).
    expect(coerceEquipmentSlug("нужна духовка")).toBeNull();
    expect(coerceEquipmentSlug("миксером")).toBeNull();
  });
});

describe("coerceEquipmentList", () => {
  it("drops unknowns, dedupes, and keeps order stable", () => {
    expect(
      coerceEquipmentList([
        "духовка",
        "соковыжималка",
        "Духовка",
        "миксер",
        "ё-мультиварка-not-a-real-word",
        "мультиварка",
      ]),
    ).toEqual(["oven", "mixer", "multicooker"]);
  });

  it("returns an empty list for an empty or all-unknown input", () => {
    expect(coerceEquipmentList([])).toEqual([]);
    expect(coerceEquipmentList(["соковыжималка", "щипцы"])).toEqual([]);
  });

  it("dedupes a slug and its Russian word as the same appliance", () => {
    expect(coerceEquipmentList(["oven", "духовка", "Oven"])).toEqual(["oven"]);
  });
});

describe("EQUIPMENT_WORD (task 4.6's prompt vocabulary)", () => {
  it("names every preset", () => {
    expect(Object.keys(EQUIPMENT_WORD).sort()).toEqual(
      [...EQUIPMENT_PRESETS].sort(),
    );
  });

  it("round-trips: every word this module writes, it can read back", () => {
    // The invariant that matters. The adaptation prompt tells a model «НЕТ на
    // кухне: тёрка»; the same module has to recognize «тёрка» when it comes
    // back through a profile or a parsed recipe, or the two halves of one
    // vocabulary quietly disagree.
    for (const slug of EQUIPMENT_PRESETS) {
      expect(coerceEquipmentSlug(EQUIPMENT_WORD[slug]), slug).toBe(slug);
    }
  });
});

describe("prototype-named entries (round 2, R2)", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "returns null for %s rather than an inherited member",
    (entry) => {
      // `WORD_TO_SLUG` is an object literal, so a bare lookup handed back
      // `Object`'s own functions typed as `EquipmentSlug`. A kitchen profile
      // can hold any 1–40-character string a household types.
      expect(coerceEquipmentSlug(entry)).toBeNull();
    },
  );

  it("drops them from a list instead of poisoning it", () => {
    expect(coerceEquipmentList(["constructor", "духовка"])).toEqual(["oven"]);
  });
});
