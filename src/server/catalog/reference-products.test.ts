import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORY_SLUGS } from "@/server/catalog/default-categories";
import { REFERENCE_PRODUCTS } from "@/server/catalog/reference-products";
import { UNITS } from "@/lib/units";

/** trim/lower/ё→е — the normalization the catalog and search (task 1.3) share. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("ё", "е");
}

// A representative sample of DESIGN_BRIEF §5's example content — not
// exhaustive of every word in the doc, but enough to prove the catalog was
// built against it rather than invented independently.
const MUST_HAVE_NAMES = [
  "Помидоры",
  "Помидоры черри",
  "Огурцы",
  "Лимоны",
  "Авокадо",
  "Молоко",
  "Масло сливочное",
  "Яйца",
  "Куриное филе",
  "Фарш говяжий",
  "Мука",
  "Шоколад тёмный",
  "Разрыхлитель",
  "Чеснок",
  "Рис",
  "Паста",
  "Масло оливковое",
  "Томаты в собственном соку",
  "Кофе",
  "Соль",
  "Листы лазаньи",
  "Пармезан",
  "Моцарелла",
  "Лук",
  "Морковь",
  "Перец болгарский",
  "Кинза",
  "Кокосовое молоко",
  "Кукурузный крахмал",
  "Сахар белый",
  "Сахар коричневый",
  "Сливки",
];

const CATEGORY_SLUGS = new Set<string>(DEFAULT_CATEGORY_SLUGS);
const VALID_UNITS = new Set<string>(UNITS);

describe("REFERENCE_PRODUCTS", () => {
  it("has between 160 and 200 entries", () => {
    expect(REFERENCE_PRODUCTS.length).toBeGreaterThanOrEqual(160);
    expect(REFERENCE_PRODUCTS.length).toBeLessThanOrEqual(200);
  });

  it("has unique names after normalization", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const product of REFERENCE_PRODUCTS) {
      const key = normalize(product.name);
      const existing = seen.get(key);
      if (existing) {
        duplicates.push(`"${product.name}" collides with "${existing}"`);
      } else {
        seen.set(key, product.name);
      }
    }

    expect(duplicates).toEqual([]);
  });

  it("uses only valid category slugs", () => {
    for (const product of REFERENCE_PRODUCTS) {
      expect(
        CATEGORY_SLUGS.has(product.categorySlug),
        `"${product.name}" has unknown categorySlug "${product.categorySlug}"`,
      ).toBe(true);
    }
  });

  it("gives every product a non-empty icon", () => {
    for (const product of REFERENCE_PRODUCTS) {
      expect(
        product.icon.length,
        `"${product.name}" has no icon`,
      ).toBeGreaterThan(0);
    }
  });

  it("uses only units from the shared UNITS contract", () => {
    for (const product of REFERENCE_PRODUCTS) {
      expect(
        VALID_UNITS.has(product.unit),
        `"${product.name}" has invalid unit "${product.unit}"`,
      ).toBe(true);
    }
  });

  it("keeps aliases lowercase", () => {
    for (const product of REFERENCE_PRODUCTS) {
      for (const alias of product.aliases) {
        expect(
          alias,
          `"${product.name}" has a non-lowercase alias "${alias}"`,
        ).toBe(alias.toLowerCase());
      }
    }
  });

  it("keeps aliases unique per product", () => {
    for (const product of REFERENCE_PRODUCTS) {
      const unique = new Set(product.aliases);
      expect(
        unique.size,
        `"${product.name}" has a duplicate alias among [${product.aliases.join(", ")}]`,
      ).toBe(product.aliases.length);
    }
  });

  it("never lets an alias equal its own product's normalized name", () => {
    for (const product of REFERENCE_PRODUCTS) {
      const normalizedName = normalize(product.name);
      for (const alias of product.aliases) {
        expect(
          normalize(alias),
          `"${product.name}" has an alias equal to its own name: "${alias}"`,
        ).not.toBe(normalizedName);
      }
    }
  });

  it("includes every must-have product named in DESIGN_BRIEF §5", () => {
    const names = new Set(
      REFERENCE_PRODUCTS.map((product) => normalize(product.name)),
    );

    for (const mustHave of MUST_HAVE_NAMES) {
      expect(names.has(normalize(mustHave)), `missing "${mustHave}"`).toBe(
        true,
      );
    }
  });

  it("spreads products across all 7 departments", () => {
    const counts = new Map<string, number>();
    for (const product of REFERENCE_PRODUCTS) {
      counts.set(
        product.categorySlug,
        (counts.get(product.categorySlug) ?? 0) + 1,
      );
    }

    for (const slug of DEFAULT_CATEGORY_SLUGS) {
      expect(
        counts.get(slug) ?? 0,
        `no products for "${slug}"`,
      ).toBeGreaterThan(0);
    }
  });
});
