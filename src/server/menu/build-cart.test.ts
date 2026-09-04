import { describe, expect, it } from "vitest";

import { cartItemStatusEnum } from "@/db/schema";
import { UNITS, type RecipeUnit, type Unit } from "@/lib/units";
import {
  buildCartPlan,
  planCartStatusSchema,
  previewLineOutput,
  PREVIEW_GROUP_ORDER,
  type CartPlan,
  type PlanCartLine,
  type PlanIngredient,
  type PlanInput,
  type PlanProduct,
  type PlanSource,
  type PreviewLine,
} from "@/server/menu/build-cart";
import { decideCartAdd, MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import { RAN_OUT_QTY } from "@/server/pantry/ran-out";

/**
 * Stable uuids keyed by a readable tag, so a fixture reads «Лук» rather than
 * a hex string and the same tag always means the same row.
 */
const ids = new Map<string, string>();

function uid(tag: string): string {
  const existing = ids.get(tag);
  if (existing !== undefined) {
    return existing;
  }
  const minted = `3f1a6d0e-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`;
  ids.set(tag, minted);
  return minted;
}

const productId = (name: string) => uid(`product:${name}`);

interface DishOptions {
  portions?: number;
  base?: number;
  cookedAt?: Date | null;
}

function dish(title: string, options: DishOptions = {}): PlanSource {
  const base = options.base ?? 2;
  return {
    sourceId: uid(`source:${title}`),
    dishId: uid(`dish:${title}`),
    dishTitle: title,
    portions: options.portions ?? base,
    portionsBase: base,
    cookedAt: options.cookedAt ?? null,
  };
}

interface RowOptions {
  qty?: number | null;
  unit?: RecipeUnit | null;
  note?: string | null;
  isOptional?: boolean;
  needsReview?: boolean;
  /** The product this row is bound to; `null` leaves it unbound. */
  product?: string | null;
}

function row(
  dishTitle: string,
  name: string,
  options: RowOptions = {},
): PlanIngredient {
  const bound = options.product === undefined ? name : options.product;
  return {
    ingredientId: uid(`ingredient:${dishTitle}:${name}`),
    sourceId: uid(`source:${dishTitle}`),
    productId: bound === null ? null : productId(bound),
    name,
    qty: options.qty ?? null,
    unit: options.unit ?? null,
    note: options.note ?? null,
    isOptional: options.isOptional ?? false,
    needsReview: options.needsReview ?? false,
  };
}

interface ProductSpec {
  name: string;
  icon?: string;
  defaultUnit?: Unit;
  categorySortOrder?: number;
}

function catalog(
  ...specs: ReadonlyArray<string | ProductSpec>
): ReadonlyMap<string, PlanProduct> {
  const map = new Map<string, PlanProduct>();

  for (const spec of specs) {
    const entry = typeof spec === "string" ? { name: spec } : spec;
    const sortOrder = entry.categorySortOrder ?? 0;
    const id = productId(entry.name);

    map.set(id, {
      id,
      name: entry.name,
      icon: entry.icon ?? "🛒",
      categoryId: uid(`category:${sortOrder}`),
      categorySortOrder: sortOrder,
      defaultUnit: entry.defaultUnit ?? "шт",
    });
  }

  return map;
}

function cartOf(
  entries: Record<string, PlanCartLine>,
): ReadonlyMap<string, PlanCartLine> {
  return new Map(
    Object.entries(entries).map(([name, line]) => [productId(name), line]),
  );
}

const pantryOf = (...names: string[]) =>
  new Set(names.map((name) => productId(name)));

function plan(
  input: Pick<PlanInput, "sources" | "ingredients" | "products"> &
    Partial<PlanInput>,
): CartPlan {
  return buildCartPlan({
    cart: new Map(),
    pantry: new Set(),
    ...input,
  });
}

function lineFor(result: CartPlan, name: string): PreviewLine {
  const line = result.lines.find((entry) => entry.productName === name);
  expect(line, `no preview line for «${name}»`).toBeDefined();
  return line as PreviewLine;
}

/** Every `{sourceId, ingredient}` pair the plan accounted for, once each. */
function accountedIngredients(result: CartPlan): string[] {
  const seen: string[] = [];

  for (const line of result.lines) {
    for (const option of line.options) {
      for (const contribution of option.contributions) {
        seen.push(`${contribution.dishTitle}`);
      }
    }
    for (const contribution of line.uncounted) {
      seen.push(`${contribution.dishTitle}`);
    }
  }

  for (const entry of result.skipped) {
    seen.push(entry.dishTitle);
  }

  return seen;
}

describe("planCartStatusSchema", () => {
  it("knows exactly the statuses the database column can hold", () => {
    // The tuple is written out in `build-cart.ts` rather than imported from
    // `routers/cart.ts`, because the sheet imports that module at runtime and
    // the router drags drizzle and the tRPC context with it. This is the
    // guard that keeps the copy honest.
    expect(planCartStatusSchema.options).toEqual([
      ...cartItemStatusEnum.enumValues,
    ]);
  });
});

describe("PREVIEW_GROUP_ORDER", () => {
  it("is DESIGN_BRIEF §5's own three sections plus the honest fourth", () => {
    expect([...PREVIEW_GROUP_ORDER]).toEqual([
      "add",
      "pantry",
      "inCart",
      "manual",
    ]);
  });
});

describe("step 0 — which sources count", () => {
  it("drops a cooked source and counts it in cookedSkipped", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье", { cookedAt: new Date() })],
      ingredients: [
        row("Лазанья", "Лук", { qty: 2, unit: "шт" }),
        row("Печенье", "Мука", { qty: 285, unit: "г" }),
      ],
      products: catalog("Лук", { name: "Мука", defaultUnit: "г" }),
    });

    expect(result.lines.map((line) => line.productName)).toEqual(["Лук"]);
    expect(result.cookedSkipped).toBe(1);
    expect(result.dishCount).toBe(1);
  });

  it("returns an empty plan for a pool that is cooked all the way down", () => {
    const result = plan({
      sources: [
        dish("Лазанья", { cookedAt: new Date() }),
        dish("Печенье", { cookedAt: new Date() }),
      ],
      ingredients: [row("Лазанья", "Лук", { qty: 2, unit: "шт" })],
      products: catalog("Лук"),
    });

    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.dishCount).toBe(0);
    expect(result.cookedSkipped).toBe(2);
  });

  it("accepts a source with no ingredients — a title is not an error", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Заготовка")],
      ingredients: [row("Лазанья", "Лук", { qty: 2, unit: "шт" })],
      products: catalog("Лук"),
    });

    expect(result.dishCount).toBe(2);
    expect(result.lines).toHaveLength(1);
  });
});

describe("step 1 — rescale", () => {
  it("passes the stored quantity through untouched at the recipe's own portions", () => {
    // S7 opens on `portionsBase`, so an unmoved slider must perturb nothing.
    const result = plan({
      sources: [dish("Лазанья", { base: 4, portions: 4 })],
      ingredients: [row("Лазанья", "Пармезан", { qty: 0.1 + 0.2, unit: "кг" })],
      products: catalog({ name: "Пармезан", defaultUnit: "кг" }),
    });

    expect(lineFor(result, "Пармезан").options[0]?.contributions[0]?.qty).toBe(
      0.1 + 0.2,
    );
  });

  it("doubles every quantity for a 2 → 4 rescale", () => {
    const result = plan({
      sources: [dish("Шакшука", { base: 2, portions: 4 })],
      ingredients: [row("Шакшука", "Лук", { qty: 1, unit: "шт" })],
      products: catalog("Лук"),
    });

    expect(lineFor(result, "Лук").options[0]?.qty).toBe(2);
  });

  it("rounds a rescale to the three decimals the column holds", () => {
    const result = plan({
      sources: [dish("Шакшука", { base: 3, portions: 1 })],
      ingredients: [row("Шакшука", "Пармезан", { qty: 100, unit: "г" })],
      products: catalog({ name: "Пармезан", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Пармезан").options[0]?.qty).toBe(33.333);
  });
});

describe("invariant 1 — one line per product", () => {
  it("«лук в двух блюдах даёт одну строку»", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Лук", { qty: 2, unit: "шт" }),
        row("Шакшука", "Лук", { qty: 1, unit: "шт" }),
      ],
      products: catalog("Лук"),
    });

    expect(result.lines).toHaveLength(1);

    const line = lineFor(result, "Лук");
    expect(line.options).toHaveLength(1);
    expect(line.options[0]?.qty).toBe(3);
    expect(line.options[0]?.unit).toBe("шт");
    // Source order — «лазанья 2 + шакшука 1», the order the cards sit in.
    expect(
      line.options[0]?.contributions.map((c) => [c.dishTitle, c.qty]),
    ).toEqual([
      ["Лазанья", 2],
      ["Шакшука", 1],
    ]);
  });
});

describe("step 3 — how one row is classified", () => {
  it("class A: a bound purchase quantity is the one summable class", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Пармезан", { qty: 150, unit: "г" })],
      products: catalog({ name: "Пармезан", defaultUnit: "г" }),
    });

    const option = lineFor(result, "Пармезан").options[0];
    expect(option).toMatchObject({ qty: 150, unit: "г", qtySource: "summed" });
    expect(option?.contributions[0]).toMatchObject({
      kind: "summed",
      stated: "150 г",
    });
  });

  it("class B: «2 зубчика» never becomes «2 шт»", () => {
    const result = plan({
      sources: [dish("Шакшука")],
      ingredients: [
        row("Шакшука", "Чеснок", { qty: 2, unit: null, note: "зубчик" }),
      ],
      products: catalog({ name: "Чеснок", defaultUnit: "шт" }),
    });

    const option = lineFor(result, "Чеснок").options[0];
    // Two cloves are not two heads of garlic: the number is dropped and the
    // row states presence at the catalog's own unit instead.
    expect(option).toMatchObject({ qty: RAN_OUT_QTY, qtySource: "fallback" });
    expect(option?.contributions[0]).toMatchObject({
      kind: "noUnit",
      qty: 2,
      stated: "зубчик",
    });
  });

  it("class C: «¾ ч.л.» is presence, never converted to grams", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [row("Печенье", "Соль", { qty: 0.75, unit: "ч.л." })],
      products: catalog({ name: "Соль", defaultUnit: "уп" }),
    });

    const option = lineFor(result, "Соль").options[0];
    expect(option).toMatchObject({
      qty: RAN_OUT_QTY,
      unit: "уп",
      qtySource: "fallback",
    });
    expect(option?.contributions[0]).toMatchObject({
      kind: "recipeUnit",
      stated: "¾ ч.л.",
    });
  });

  it("class D: a needsReview row is presence and lights the line's chip", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Кукурузный крахмал", { qty: null, needsReview: true }),
      ],
      products: catalog({ name: "Кукурузный крахмал", defaultUnit: "уп" }),
    });

    const line = lineFor(result, "Кукурузный крахмал");
    expect(line.needsReview).toBe(true);
    expect(line.options[0]?.contributions[0]).toMatchObject({
      kind: "needsReview",
      stated: null,
    });
  });

  it("class E: «по вкусу» is presence and wears no chip", () => {
    const result = plan({
      sources: [dish("Шакшука")],
      ingredients: [row("Шакшука", "Соль", { qty: null, note: "по вкусу" })],
      products: catalog({ name: "Соль", defaultUnit: "уп" }),
    });

    const line = lineFor(result, "Соль");
    expect(line.needsReview).toBe(false);
    expect(line.options[0]?.contributions[0]).toMatchObject({
      kind: "unquantifiable",
      stated: "по вкусу",
    });
  });

  it("class F: no quantity, no explanation, a stale flag — presence, no chip", () => {
    const result = plan({
      sources: [dish("Шакшука")],
      ingredients: [
        row("Шакшука", "Кинза", { qty: null, note: null, needsReview: false }),
      ],
      products: catalog({ name: "Кинза", defaultUnit: "пучок" }),
    });

    const line = lineFor(result, "Кинза");
    expect(line.needsReview).toBe(false);
    expect(line.options[0]?.contributions[0]).toMatchObject({
      kind: "needsReview",
      stated: null,
    });
  });

  it("class G: a rescale to 0,0004 is presence, never an option of «0»", () => {
    const result = plan({
      sources: [dish("Печенье", { base: 12, portions: 1 })],
      ingredients: [row("Печенье", "Сода", { qty: 0.005, unit: "кг" })],
      products: catalog({ name: "Сода", defaultUnit: "уп" }),
    });

    const option = lineFor(result, "Сода").options[0];
    expect(option).toMatchObject({ qty: RAN_OUT_QTY, qtySource: "fallback" });
    expect(option?.contributions[0]).toMatchObject({
      kind: "tooSmall",
      stated: null,
    });
  });

  it("class H: «Biscoff 150 г — опционально» does not join the sum", () => {
    // The D10 regression, named for it: `recipe_ingredients.is_optional`'s own
    // schema comment says the column exists to stop 5.2 buying a garnish by
    // default, and a table that keyed on qty/unit first would let this row in.
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Шоколад", { qty: 150, unit: "г" }),
        row("Печенье", "Biscoff", {
          qty: 150,
          unit: "г",
          isOptional: true,
          product: "Шоколад",
        }),
      ],
      products: catalog({ name: "Шоколад", defaultUnit: "г" }),
    });

    const line = lineFor(result, "Шоколад");
    expect(line.group).toBe("add");
    expect(line.optional).toBe(false);
    expect(line.options[0]?.qty).toBe(150);
    expect(line.uncounted).toHaveLength(1);
    expect(line.uncounted[0]).toMatchObject({ kind: "optional" });
  });

  it("class H mixed: the non-optional row rules, the optional one is named", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Пармезан", { qty: 150, unit: "г" }),
        row("Печенье", "Пармезан", { qty: 50, unit: "г", isOptional: true }),
      ],
      products: catalog({ name: "Пармезан", defaultUnit: "г" }),
    });

    const line = lineFor(result, "Пармезан");
    expect(line.options[0]?.qty).toBe(150);
    expect(line.uncounted.map((c) => c.dishTitle)).toEqual(["Печенье"]);
  });

  it("class I: two unbound rows with the same name stay two skipped entries", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Специи по-домашнему", { product: null }),
        row("Шакшука", "Специи по-домашнему", { product: null }),
      ],
      products: catalog(),
    });

    expect(result.lines).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((entry) => entry.reason === "unbound")).toBe(
      true,
    );
    expect(result.counts.skipped).toBe(2);
  });

  it("degrades a product the catalog read did not answer for the same way", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Лук", { qty: 2, unit: "шт" })],
      products: catalog(),
    });

    expect(result.lines).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ name: "Лук", reason: "unbound" });
  });

  it("rescales a skipped row too, so the sheet shows this build's number", () => {
    const result = plan({
      sources: [dish("Лазанья", { base: 2, portions: 4 })],
      ingredients: [
        row("Лазанья", "Специи по-домашнему", {
          qty: 1,
          unit: "ч.л.",
          product: null,
        }),
      ],
      products: catalog(),
    });

    expect(result.skipped[0]).toMatchObject({ qty: 2, unit: "ч.л." });
  });
});

describe("step 4 — the bucket's options", () => {
  it("folds with roundQty after every addition — three thirds are 0,999", () => {
    const result = plan({
      sources: [dish("A"), dish("B"), dish("C")],
      ingredients: [
        row("A", "Мука", { qty: 0.333, unit: "кг" }),
        row("B", "Мука", { qty: 0.333, unit: "кг" }),
        row("C", "Мука", { qty: 0.333, unit: "кг" }),
      ],
      products: catalog({ name: "Мука", defaultUnit: "кг" }),
    });

    // The cost this codebase already lives with, rather than a second rule
    // that disagrees with `decideCartAdd`'s own merge line.
    expect(lineFor(result, "Мука").options[0]?.qty).toBe(0.999);
  });

  it("caps a runaway sum at MAX_QTY", () => {
    const result = plan({
      sources: [dish("A"), dish("B")],
      ingredients: [
        row("A", "Мука", { qty: MAX_QTY, unit: "г" }),
        row("B", "Мука", { qty: MAX_QTY, unit: "г" }),
      ],
      products: catalog({ name: "Мука", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Мука").options[0]?.qty).toBe(MAX_QTY);
  });

  it("«200 г» + «1 шт» stays two options with nothing preselected", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Помидоры", { qty: 200, unit: "г" }),
        row("Шакшука", "Помидоры", { qty: 1, unit: "шт" }),
      ],
      products: catalog({ name: "Помидоры", defaultUnit: "шт" }),
    });

    const line = lineFor(result, "Помидоры");
    expect(line.options).toHaveLength(2);
    expect(line.defaultUnit).toBeNull();
    expect(line.group).toBe("manual");
    expect(line.reason).toBe("unitConflict");
    expect(
      line.options.flatMap((option) =>
        option.contributions.map((c) => c.dishTitle),
      ),
    ).toEqual(expect.arrayContaining(["Лазанья", "Шакшука"]));
  });

  it("uses RAN_OUT_QTY × the product's default unit for a presence bucket", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [row("Печенье", "Соль", { qty: null, note: "по вкусу" })],
      products: catalog({ name: "Соль", defaultUnit: "уп" }),
    });

    // Asserted against the imported constant, never a literal 1: «кончилось»
    // and «рецепт просит соль, а сколько — не сказал» are the same assertion
    // of presence, and reusing the constant is what stops the two drifting.
    expect(lineFor(result, "Соль").options[0]).toMatchObject({
      qty: RAN_OUT_QTY,
      unit: "уп",
      qtySource: "fallback",
    });
  });
});

describe("step 4 — exact metric conversion (A2)", () => {
  it("sums «200 г» and «85 г» into the catalog's own «кг»", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Мука", { qty: 200, unit: "г" }),
        row("Печенье", "Мука", { qty: 85, unit: "г" }),
      ],
      products: catalog({ name: "Мука", defaultUnit: "кг" }),
    });

    const line = lineFor(result, "Мука");
    expect(line.options).toHaveLength(1);
    expect(line.options[0]).toMatchObject({ qty: 0.285, unit: "кг" });
    expect(line.defaultUnit).toBe("кг");
  });

  it("falls back to the largest contribution's unit when the catalog disagrees", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Мука", { qty: 200, unit: "г" }),
        row("Печенье", "Мука", { qty: 0.3, unit: "кг" }),
      ],
      // «шт» is not commensurable with either, so rule 2 cannot apply.
      products: catalog({ name: "Мука", defaultUnit: "шт" }),
    });

    expect(lineFor(result, "Мука").options[0]).toMatchObject({
      qty: 0.5,
      unit: "кг",
    });
  });

  it("breaks a tie towards the finer unit — «0,2 кг» + «200 г» is «400 г»", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Мука", { qty: 0.2, unit: "кг" }),
        row("Печенье", "Мука", { qty: 200, unit: "г" }),
      ],
      products: catalog({ name: "Мука", defaultUnit: "шт" }),
    });

    expect(lineFor(result, "Мука").options[0]).toMatchObject({
      qty: 400,
      unit: "г",
    });
  });

  it("never converts a kitchen measure into a purchase unit", () => {
    const result = plan({
      sources: [dish("Печенье"), dish("Лазанья")],
      ingredients: [
        row("Печенье", "Соль", { qty: 0.75, unit: "ч.л." }),
        row("Лазанья", "Соль", { qty: 5, unit: "г" }),
      ],
      products: catalog({ name: "Соль", defaultUnit: "г" }),
    });

    const line = lineFor(result, "Соль");
    // The gram-per-teaspoon ratio differs for salt, flour and honey; VISION
    // §3.4 normalizes kitchen units at import, not here.
    expect(line.options).toHaveLength(1);
    expect(line.options[0]).toMatchObject({ qty: 5, unit: "г" });
    expect(line.uncounted[0]).toMatchObject({ kind: "recipeUnit" });
  });

  it("never converts across families — «200 г» and «200 мл» stay two options", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Сливки", { qty: 200, unit: "г" }),
        row("Печенье", "Сливки", { qty: 200, unit: "мл" }),
      ],
      products: catalog({ name: "Сливки", defaultUnit: "мл" }),
    });

    expect(lineFor(result, "Сливки").options).toHaveLength(2);
  });

  it("demotes a group whose converted total cannot survive MIN_QTY", () => {
    // «0,4 г» into a «кг» line is 0,0004 — stored as 0,000. An option of
    // «0 кг» would claim the recipe needs none of something.
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [row("Печенье", "Сода", { qty: 0.4, unit: "г" })],
      products: catalog({ name: "Сода", defaultUnit: "уп" }),
      cart: cartOf({ Сода: { qty: 1, unit: "кг", status: "needed" } }),
    });

    const line = lineFor(result, "Сода");
    expect(line.options[0]).toMatchObject({
      qty: RAN_OUT_QTY,
      unit: "уп",
      qtySource: "fallback",
    });
    expect(line.options[0]?.contributions[0]).toMatchObject({
      kind: "tooSmall",
      stated: null,
    });
  });
});

describe("step 5 — the group ladder", () => {
  it("puts a product that is both in the cart and in the pantry into inCart", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Лук", { qty: 2, unit: "шт" })],
      products: catalog("Лук"),
      cart: cartOf({ Лук: { qty: 1, unit: "шт", status: "needed" } }),
      pantry: pantryOf("Лук"),
    });

    // Keeps DESIGN_BRIEF §5's three counts disjoint, and the cart is where a
    // further decision has consequences.
    expect(lineFor(result, "Лук").group).toBe("inCart");
    expect(result.counts).toMatchObject({ inCart: 1, pantry: 0 });
  });

  it("puts an optional-only product that is in the pantry into manual/optional", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Biscoff", { qty: 150, unit: "г", isOptional: true }),
      ],
      products: catalog({ name: "Biscoff", defaultUnit: "г" }),
      pantry: pantryOf("Biscoff"),
    });

    const line = lineFor(result, "Biscoff");
    expect(line).toMatchObject({
      group: "manual",
      reason: "optional",
      optional: true,
      defaultUnit: null,
      selectable: true,
    });
  });

  it("«опциональный продукт, уже лежащий в корзине, не предлагает несовместимую единицу»", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Biscoff", { qty: 150, unit: "г", isOptional: true }),
      ],
      products: catalog({ name: "Biscoff", defaultUnit: "г" }),
      cart: cartOf({ Biscoff: { qty: 1, unit: "банка", status: "needed" } }),
    });

    const line = lineFor(result, "Biscoff");
    // Both facts at once: the «опционально» chip and the «уже в корзине»
    // sub-line — while the counts stay disjoint (one line, counted in inCart).
    expect(line).toMatchObject({
      group: "inCart",
      reason: "inCartUnits",
      optional: true,
      selectable: false,
      defaultUnit: null,
    });
    expect(result.counts).toMatchObject({ inCart: 1, manual: 0 });
  });

  it("«опциональный продукт, уже купленный, предлагает вернуть»", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Biscoff", { qty: 150, unit: "г", isOptional: true }),
      ],
      products: catalog({ name: "Biscoff", defaultUnit: "г" }),
      cart: cartOf({ Biscoff: { qty: 1, unit: "банка", status: "bought" } }),
    });

    expect(lineFor(result, "Biscoff")).toMatchObject({
      group: "inCart",
      reason: "inCartBought",
      intent: "restore",
      optional: true,
      selectable: true,
    });
  });

  it("keeps a pantry row's real options, so ticking it adds the real amount", () => {
    const result = plan({
      sources: [dish("Шакшука")],
      ingredients: [row("Шакшука", "Чеснок", { qty: 3, unit: "шт" })],
      products: catalog("Чеснок"),
      pantry: pantryOf("Чеснок"),
    });

    expect(lineFor(result, "Чеснок")).toMatchObject({
      group: "pantry",
      reason: "inPantry",
      defaultUnit: null,
      selectable: true,
      intent: "add",
    });
    expect(lineFor(result, "Чеснок").options[0]?.qty).toBe(3);
  });

  it("preselects only a plain «add» row — the footer's number on open", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Лук", { qty: 2, unit: "шт" })],
      products: catalog("Лук"),
    });

    expect(lineFor(result, "Лук")).toMatchObject({
      group: "add",
      reason: "new",
      defaultUnit: "шт",
      selectable: true,
    });
  });
});

describe("step 6 — the inCart sub-table", () => {
  it("row i: a bought line is selectable, off, restoring, with options unfiltered", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Помидоры", { qty: 200, unit: "г" }),
        row("Шакшука", "Помидоры", { qty: 1, unit: "шт" }),
      ],
      products: catalog({ name: "Помидоры", defaultUnit: "шт" }),
      cart: cartOf({ Помидоры: { qty: 6, unit: "шт", status: "bought" } }),
    });

    const line = lineFor(result, "Помидоры");
    // `decideCartAdd` checks status before unit, and a restore replaces the
    // unit anyway — so both options survive.
    expect(line.options).toHaveLength(2);
    expect(line).toMatchObject({
      reason: "inCartBought",
      intent: "restore",
      selectable: true,
      defaultUnit: null,
    });
  });

  it("row ii: a matching unit keeps one option and moves the rest to «не считали»", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Помидоры", { qty: 200, unit: "г" }),
        row("Шакшука", "Помидоры", { qty: 1, unit: "шт" }),
      ],
      products: catalog({ name: "Помидоры", defaultUnit: "шт" }),
      cart: cartOf({ Помидоры: { qty: 6, unit: "шт", status: "needed" } }),
    });

    const line = lineFor(result, "Помидоры");
    expect(line.options).toHaveLength(1);
    expect(line.options[0]).toMatchObject({ qty: 1, unit: "шт" });
    expect(line).toMatchObject({
      reason: "inCart",
      intent: "add",
      selectable: true,
      defaultUnit: null,
    });
    expect(line.uncounted.map((c) => [c.qty, c.unit])).toEqual([[200, "г"]]);
  });

  it("row ii with conversion: a «кг» line against «200 г + 85 г» offers «0,285 кг»", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Мука", { qty: 200, unit: "г" }),
        row("Печенье", "Мука", { qty: 85, unit: "г" }),
        row("Шакшука", "Мука", { qty: 1, unit: "уп" }),
      ],
      products: catalog({ name: "Мука", defaultUnit: "г" }),
      cart: cartOf({ Мука: { qty: 1, unit: "кг", status: "ordered" } }),
    });

    const line = lineFor(result, "Мука");
    expect(line.options).toHaveLength(1);
    expect(line.options[0]).toMatchObject({ qty: 0.285, unit: "кг" });
    expect(line.defaultUnit).toBeNull();
    // The «уп» group is real but unwritable against a «кг» row, so it is named
    // rather than silently dropped.
    expect(line.uncounted.map((c) => c.unit)).toEqual(["уп"]);
    expect(line.inCart).toEqual({ qty: 1, unit: "кг", status: "ordered" });
  });

  it("row iii: no commensurable option refuses with selectable:false and keeps the options", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Мука", { qty: 285, unit: "г" })],
      products: catalog({ name: "Мука", defaultUnit: "г" }),
      cart: cartOf({ Мука: { qty: 1, unit: "уп", status: "ordered" } }),
    });

    const line = lineFor(result, "Мука");
    // B3: the refusal is `selectable: false`, never an empty options list —
    // «в корзине 1 уп · по рецепту 285 г» needs the 285 г to say anything.
    expect(line.options).toHaveLength(1);
    expect(line.options[0]).toMatchObject({ qty: 285, unit: "г" });
    expect(line).toMatchObject({
      reason: "inCartUnits",
      selectable: false,
      defaultUnit: null,
    });
    expect(previewLineOutput.parse(line).options).toHaveLength(1);
  });

  it("row iii: a stored unit the app no longer knows never matches", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Мука", { qty: 2, unit: "шт" })],
      products: catalog({ name: "Мука", defaultUnit: "шт" }),
      cart: cartOf({ Мука: { qty: 1, unit: "мешок", status: "needed" } }),
    });

    const line = lineFor(result, "Мука");
    expect(line.reason).toBe("inCartUnits");
    expect(line.selectable).toBe(false);
    expect(line.inCart?.unit).toBe("мешок");
  });

  it("states the need in the cart's own unit when the cart already covers it", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [row("Печенье", "Мука", { qty: 285, unit: "г" })],
      products: catalog({ name: "Мука", defaultUnit: "г" }),
      cart: cartOf({ Мука: { qty: 1, unit: "кг", status: "ordered" } }),
    });

    const line = lineFor(result, "Мука");
    // DESIGN_BRIEF §5: «🌾 Мука (в корзине 1 кг — хватает)». Both numbers are
    // in «кг», which is what makes that sentence renderable at all.
    expect(line.options[0]).toMatchObject({ qty: 0.285, unit: "кг" });
    expect(line.inCart?.qty).toBe(1);
    expect((line.inCart?.qty ?? 0) >= (line.options[0]?.qty ?? 0)).toBe(true);
  });

  it("states a shortfall in the cart's own unit too", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Молоко", { qty: 1500, unit: "мл" })],
      products: catalog({ name: "Молоко", defaultUnit: "л" }),
      cart: cartOf({ Молоко: { qty: 1, unit: "л", status: "ordered" } }),
    });

    const line = lineFor(result, "Молоко");
    expect(line.options[0]).toMatchObject({ qty: 1.5, unit: "л" });
    expect((line.inCart?.qty ?? 0) < (line.options[0]?.qty ?? 0)).toBe(true);
  });
});

describe("step 7 — the note on a new line", () => {
  it("carries a single contribution's own note", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Шоколад", {
          qty: 150,
          unit: "г",
          note: "крупными кусками",
        }),
      ],
      products: catalog({ name: "Шоколад", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Шоколад").note).toBe("крупными кусками");
  });

  it("drops the note when two contributions describe two different uses", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Печенье")],
      ingredients: [
        row("Лазанья", "Масло", { qty: 50, unit: "г", note: "холодное" }),
        row("Печенье", "Масло", {
          qty: 180,
          unit: "г",
          note: "комнатной температуры",
        }),
      ],
      products: catalog({ name: "Масло", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Масло").note).toBeNull();
  });

  it("drops a note longer than the cart column's own bound", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Шоколад", {
          qty: 150,
          unit: "г",
          note: "я".repeat(201),
        }),
      ],
      products: catalog({ name: "Шоколад", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Шоколад").note).toBeNull();
  });

  it("treats a whitespace-only note as no note", () => {
    const result = plan({
      sources: [dish("Печенье")],
      ingredients: [
        row("Печенье", "Шоколад", { qty: 150, unit: "г", note: "   " }),
      ],
      products: catalog({ name: "Шоколад", defaultUnit: "г" }),
    });

    expect(lineFor(result, "Шоколад").note).toBeNull();
  });
});

describe("step 8 — ordering", () => {
  it("returns lines in the cart's own walking order", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [
        row("Лазанья", "Мука", { qty: 1, unit: "кг" }),
        row("Лазанья", "Лук", { qty: 2, unit: "шт" }),
        row("Лазанья", "Морковь", { qty: 2, unit: "шт" }),
        row("Лазанья", "Молоко", { qty: 1, unit: "л" }),
      ],
      products: catalog(
        { name: "Мука", defaultUnit: "кг", categorySortOrder: 4 },
        { name: "Лук", categorySortOrder: 0 },
        { name: "Морковь", categorySortOrder: 0 },
        { name: "Молоко", defaultUnit: "л", categorySortOrder: 1 },
      ),
    });

    expect(result.lines.map((line) => line.productName)).toEqual([
      "Лук",
      "Морковь",
      "Молоко",
      "Мука",
    ]);
  });

  it("keeps skipped rows in ingredient order", () => {
    const result = plan({
      sources: [dish("Лазанья"), dish("Шакшука")],
      ingredients: [
        row("Лазанья", "Специи", { product: null }),
        row("Шакшука", "Заправка", { product: null }),
      ],
      products: catalog(),
    });

    expect(result.skipped.map((entry) => entry.name)).toEqual([
      "Специи",
      "Заправка",
    ]);
  });
});

describe("invariant 5 — «превью не обещает того, что корзина откажется принять»", () => {
  it("never offers an option decideCartAdd would refuse", () => {
    const result = designBriefPlan();

    for (const line of result.lines) {
      if (!line.selectable) {
        continue;
      }

      for (const option of line.options) {
        const decision = decideCartAdd({
          existing: line.inCart,
          addition: { qty: option.qty, unit: option.unit },
          restore: line.intent === "restore",
        });

        expect(
          decision.outcome,
          `${line.productName} → ${decision.outcome}`,
        ).not.toBe("unitMismatch");
        expect(decision.outcome).not.toBe("boughtExists");
      }
    }
  });

  it("holds for a bought line only because the restore intent travels with it", () => {
    const result = plan({
      sources: [dish("Лазанья")],
      ingredients: [row("Лазанья", "Мука", { qty: 285, unit: "г" })],
      products: catalog({ name: "Мука", defaultUnit: "г" }),
      cart: cartOf({ Мука: { qty: 1, unit: "уп", status: "bought" } }),
    });

    const line = lineFor(result, "Мука");
    expect(line.intent).toBe("restore");
    expect(
      decideCartAdd({
        existing: line.inCart,
        addition: {
          qty: line.options[0]?.qty ?? 0,
          unit: line.options[0]?.unit ?? "шт",
        },
        restore: true,
      }).outcome,
    ).toBe("restored");
  });
});

/**
 * DESIGN_BRIEF §5's own menu, catalog, pantry and cart — the fixture behind
 * «+8 позиций · 4 уже дома · 2 уже в корзине».
 *
 * NYC Cookies is «✓ приготовлено» in the brief's own «Меню недели», so the
 * flour and the milk are the lasagna's béchamel — which is exactly what the
 * brief's own «🥛 Молоко (в корзине 1 л «заказано», для бешамеля нужно ещё)»
 * says they are.
 */
function designBriefPlan(): CartPlan {
  return plan({
    sources: [
      dish("Лазанья болоньезе", { base: 4, portions: 4 }),
      dish("NYC Cookies", { base: 8, portions: 8, cookedAt: new Date() }),
      dish("Шакшука", { base: 2, portions: 2 }),
      dish("Том-ям", { base: 4, portions: 4 }),
    ],
    ingredients: [
      row("Лазанья болоньезе", "Листы лазаньи", { qty: 1, unit: "уп" }),
      row("Лазанья болоньезе", "Пармезан", { qty: 150, unit: "г" }),
      row("Лазанья болоньезе", "Моцарелла", { qty: 200, unit: "г" }),
      row("Лазанья болоньезе", "Лук", { qty: 2, unit: "шт" }),
      row("Лазанья болоньезе", "Морковь", { qty: 2, unit: "шт" }),
      row("Лазанья болоньезе", "Молоко", { qty: 200, unit: "мл" }),
      row("Лазанья болоньезе", "Мука", { qty: 285, unit: "г" }),
      row("Лазанья болоньезе", "Чеснок", { qty: 3, unit: "шт" }),
      row("Лазанья болоньезе", "Масло оливковое", { qty: 2, unit: "ст.л." }),
      row("Лазанья болоньезе", "Томаты в собственном соку", {
        qty: 1,
        unit: "банка",
      }),
      row("Лазанья болоньезе", "Соль", { qty: 0.75, unit: "ч.л." }),
      row("NYC Cookies", "Мука", { qty: 285, unit: "г" }),
      row("NYC Cookies", "Шоколад тёмный", { qty: 150, unit: "г" }),
      row("Шакшука", "Лук", { qty: 1, unit: "шт" }),
      row("Шакшука", "Перец болгарский", { qty: 2, unit: "шт" }),
      row("Шакшука", "Томаты в собственном соку", { qty: 1, unit: "банка" }),
      row("Шакшука", "Чеснок", { qty: 2, unit: "шт" }),
      row("Шакшука", "Соль", { qty: null, note: "по вкусу" }),
      row("Том-ям", "Кинза", { qty: 1, unit: "пучок" }),
      row("Том-ям", "Кокосовое молоко", { qty: 1, unit: "банка" }),
      row("Том-ям", "Соль", { qty: null, note: "по вкусу" }),
    ],
    products: catalog(
      { name: "Лук", categorySortOrder: 0 },
      { name: "Морковь", categorySortOrder: 0 },
      { name: "Перец болгарский", categorySortOrder: 0 },
      { name: "Кинза", defaultUnit: "пучок", categorySortOrder: 0 },
      { name: "Чеснок", categorySortOrder: 0 },
      { name: "Пармезан", defaultUnit: "г", categorySortOrder: 1 },
      { name: "Моцарелла", defaultUnit: "г", categorySortOrder: 1 },
      { name: "Молоко", defaultUnit: "л", categorySortOrder: 1 },
      { name: "Листы лазаньи", defaultUnit: "уп", categorySortOrder: 4 },
      { name: "Мука", defaultUnit: "кг", categorySortOrder: 4 },
      { name: "Кокосовое молоко", defaultUnit: "банка", categorySortOrder: 4 },
      { name: "Масло оливковое", defaultUnit: "л", categorySortOrder: 4 },
      {
        name: "Томаты в собственном соку",
        defaultUnit: "банка",
        categorySortOrder: 4,
      },
      { name: "Соль", defaultUnit: "уп", categorySortOrder: 4 },
      { name: "Шоколад тёмный", defaultUnit: "г", categorySortOrder: 4 },
    ),
    pantry: pantryOf(
      "Чеснок",
      "Масло оливковое",
      "Томаты в собственном соку",
      "Соль",
    ),
    cart: cartOf({
      Молоко: { qty: 1, unit: "л", status: "ordered" },
      Мука: { qty: 1, unit: "кг", status: "ordered" },
    }),
  });
}

describe("DESIGN_BRIEF §5 — «+8 позиций · 4 уже дома · 2 уже в корзине»", () => {
  it("reproduces the brief's own three counts", () => {
    const result = designBriefPlan();

    expect(result.counts).toEqual({
      add: 8,
      pantry: 4,
      inCart: 2,
      manual: 0,
      skipped: 0,
    });
    expect(result.dishCount).toBe(3);
    expect(result.cookedSkipped).toBe(1);
  });

  it("lists the brief's own eight «Добавим» rows", () => {
    const result = designBriefPlan();

    expect(
      result.lines
        .filter((line) => line.group === "add")
        .map((line) => line.productName),
    ).toEqual([
      "Кинза",
      "Лук",
      "Морковь",
      "Перец болгарский",
      "Моцарелла",
      "Пармезан",
      "Кокосовое молоко",
      "Листы лазаньи",
    ]);
  });

  it("sums «🧅 Лук — 3 шт (суммировано: лазанья 2 + шакшука 1)»", () => {
    const line = lineFor(designBriefPlan(), "Лук");

    expect(line.options[0]).toMatchObject({ qty: 3, unit: "шт" });
    expect(line.options[0]?.contributions.map((c) => c.dishTitle)).toEqual([
      "Лазанья болоньезе",
      "Шакшука",
    ]);
  });

  it("«🌾 Мука — в корзине 1 кг, хватает на 0,285 кг»", () => {
    const line = lineFor(designBriefPlan(), "Мука");

    expect(line.group).toBe("inCart");
    expect(line.reason).toBe("inCart");
    expect(line.selectable).toBe(true);
    expect(line.defaultUnit).toBeNull();
    expect(line.options[0]).toMatchObject({ qty: 0.285, unit: "кг" });
    expect(line.inCart).toEqual({ qty: 1, unit: "кг", status: "ordered" });
    // Only the lasagna's béchamel: the cookies are cooked, so their own 285 г
    // never reach the fold.
    expect(line.options[0]?.contributions).toHaveLength(1);
  });

  it("«🥛 Молоко — в корзине 1 л заказано, добавить 0,2 л»", () => {
    const line = lineFor(designBriefPlan(), "Молоко");

    expect(line.group).toBe("inCart");
    expect(line.reason).toBe("inCart");
    expect(line.options[0]).toMatchObject({ qty: 0.2, unit: "л" });
    expect(line.inCart).toEqual({ qty: 1, unit: "л", status: "ordered" });
  });

  it("leaves the pantry's four unticked with their real amounts", () => {
    const result = designBriefPlan();
    const pantryLines = result.lines.filter((line) => line.group === "pantry");

    expect(pantryLines.map((line) => line.productName)).toEqual([
      "Чеснок",
      "Масло оливковое",
      "Соль",
      "Томаты в собственном соку",
    ]);
    expect(pantryLines.every((line) => line.defaultUnit === null)).toBe(true);
    expect(lineFor(result, "Чеснок").options[0]?.qty).toBe(5);
    expect(lineFor(result, "Соль").options[0]).toMatchObject({
      qty: RAN_OUT_QTY,
      unit: "уп",
      qtySource: "fallback",
    });
  });

  it("counts nothing from the cooked dish", () => {
    const result = designBriefPlan();

    expect(
      result.lines.some((line) => line.productName === "Шоколад тёмный"),
    ).toBe(false);
    expect(accountedIngredients(result)).not.toContain("NYC Cookies");
  });
});

describe("invariants over a produced plan", () => {
  const result = designBriefPlan();

  it("every line satisfies its own output contract", () => {
    for (const line of result.lines) {
      expect(() => previewLineOutput.parse(line)).not.toThrow();
    }
  });

  it("every option carries a writable quantity in a known unit", () => {
    for (const line of result.lines) {
      expect(line.options.length).toBeGreaterThanOrEqual(1);

      for (const option of line.options) {
        expect(option.qty).toBeGreaterThanOrEqual(MIN_QTY);
        expect(option.qty).toBeLessThanOrEqual(MAX_QTY);
        expect(UNITS).toContain(option.unit);
      }
    }
  });

  it("a preselected unit implies a selectable «add» row with one option", () => {
    for (const line of result.lines) {
      if (line.defaultUnit === null) {
        continue;
      }

      expect(line.selectable).toBe(true);
      expect(line.group).toBe("add");
      expect(line.options).toHaveLength(1);
      expect(line.defaultUnit).toBe(line.options[0]?.unit);
    }
  });

  it("«selectable === false» happens only for an unwritable inCart row", () => {
    for (const line of result.lines.filter((entry) => !entry.selectable)) {
      expect(line.reason).toBe("inCartUnits");
      expect(line.defaultUnit).toBeNull();
    }
  });

  it("produces one line per product", () => {
    const seen = result.lines.map((line) => line.productId);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("accounts for every ingredient row of a counted source exactly once", () => {
    const counted = new Set(
      ["Лазанья болоньезе", "Шакшука", "Том-ям"].map((title) => title),
    );

    let placed = 0;
    for (const line of result.lines) {
      placed += line.options.reduce(
        (total, option) => total + option.contributions.length,
        0,
      );
      placed += line.uncounted.length;
    }
    placed += result.skipped.length;

    // 21 rows in the fixture, 2 of them the cooked dish's.
    expect(placed).toBe(19);
    expect(
      accountedIngredients(result).every((title) => counted.has(title)),
    ).toBe(true);
  });

  it("counts equal the group tallies", () => {
    for (const group of PREVIEW_GROUP_ORDER) {
      expect(result.counts[group]).toBe(
        result.lines.filter((line) => line.group === group).length,
      );
    }
    expect(result.counts.skipped).toBe(result.skipped.length);
  });
});
