import { describe, expect, it } from "vitest";

import {
  seedSelection,
  selectionCounts,
  selectionToApplyLines,
  toggleLine,
  type SelectionState,
} from "@/lib/menu/selection";
import { UNITS, type Unit } from "@/lib/units";
import type {
  CartPlan,
  PreviewLine,
  PreviewOption,
} from "@/server/menu/build-cart";

const PRODUCT = "3f1a6d0e-0000-4000-8000-000000000201";
const OTHER = "3f1a6d0e-0000-4000-8000-000000000202";

function option(qty: number, unit: Unit): PreviewOption {
  return { qty, unit, qtySource: "summed", contributions: [] };
}

function line(overrides: Partial<PreviewLine> = {}): PreviewLine {
  return {
    productId: PRODUCT,
    productName: "Лук",
    productIcon: "🧅",
    categoryId: "3f1a6d0e-0000-4000-8000-000000000101",
    group: "add",
    options: [option(3, "шт")],
    defaultUnit: "шт",
    selectable: true,
    intent: "add",
    reason: "new",
    optional: false,
    uncounted: [],
    needsReview: false,
    inCart: null,
    note: null,
    ...overrides,
  };
}

function planOf(...lines: PreviewLine[]): CartPlan {
  return {
    lines,
    skipped: [],
    counts: {
      add: lines.filter((entry) => entry.group === "add").length,
      pantry: lines.filter((entry) => entry.group === "pantry").length,
      inCart: lines.filter((entry) => entry.group === "inCart").length,
      manual: lines.filter((entry) => entry.group === "manual").length,
      skipped: 0,
    },
    dishCount: 1,
    cookedSkipped: 0,
  };
}

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPlan(seed: number): CartPlan {
  const random = randomFrom(seed);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)] as T;

  const lines: PreviewLine[] = [];
  const count = 1 + Math.floor(random() * 12);

  for (let index = 0; index < count; index += 1) {
    const options = [option(1 + Math.floor(random() * 5), pick(UNITS))];
    if (random() < 0.3) {
      const second = pick(UNITS.filter((unit) => unit !== options[0]?.unit));
      options.push(option(1 + Math.floor(random() * 5), second));
    }

    const group = pick(["add", "pantry", "inCart", "manual"] as const);
    const selectable = group === "inCart" ? random() < 0.6 : true;
    const preselect = group === "add" && options.length === 1;

    lines.push(
      line({
        productId: `3f1a6d0e-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        productName: `Продукт ${index}`,
        group,
        options,
        selectable,
        defaultUnit: preselect ? (options[0]?.unit ?? null) : null,
        intent: group === "inCart" && random() < 0.3 ? "restore" : "add",
        reason: group === "add" ? "new" : "inCart",
      }),
    );
  }

  return planOf(...lines);
}

function randomSelection(plan: CartPlan, seed: number): SelectionState {
  const random = randomFrom(seed);
  const state = new Map<string, Unit>();

  for (const entry of plan.lines) {
    const roll = random();
    if (roll < 0.4) {
      continue;
    }
    // Deliberately including units the line does not offer: the map is client
    // state and may outlive a re-fetch, so both readers have to survive it.
    state.set(
      entry.productId,
      roll < 0.8
        ? (entry.options[Math.floor(random() * entry.options.length)]?.unit ??
            "шт")
        : ((UNITS[Math.floor(random() * UNITS.length)] ?? "шт") as Unit),
    );
  }

  // A stale key for a product the plan no longer contains.
  state.set("3f1a6d0e-0000-4000-8000-0000000009ff", "шт");

  return state;
}

describe("seedSelection", () => {
  it("reproduces every line's defaultUnit and nothing else", () => {
    const plan = planOf(
      line(),
      line({ productId: OTHER, group: "pantry", defaultUnit: null }),
    );

    expect([...seedSelection(plan)]).toEqual([[PRODUCT, "шт"]]);
  });

  it("opens with nothing ticked when the plan preselects nothing (D9)", () => {
    const plan = planOf(
      line({ group: "pantry", reason: "inPantry", defaultUnit: null }),
      line({
        productId: OTHER,
        group: "inCart",
        reason: "inCart",
        defaultUnit: null,
        inCart: { qty: 1, unit: "шт", status: "needed" },
      }),
    );

    expect(seedSelection(plan).size).toBe(0);
  });
});

describe("toggleLine", () => {
  it("selects one of the line's own options", () => {
    const target = line({ defaultUnit: null });
    const next = toggleLine(new Map(), target, "шт");

    expect(next.get(PRODUCT)).toBe("шт");
  });

  it("clears the line with null", () => {
    const target = line();
    const next = toggleLine(new Map([[PRODUCT, "шт" as Unit]]), target, null);

    expect(next.has(PRODUCT)).toBe(false);
  });

  it("changes nothing for an unselectable line", () => {
    const target = line({
      selectable: false,
      reason: "inCartUnits",
      defaultUnit: null,
    });
    const state = new Map<string, Unit>();

    // The same map back, not a copy: an unchanged value must not gain a new
    // identity and re-render the sheet.
    expect(toggleLine(state, target, "шт")).toBe(state);
  });

  it("refuses a unit the line does not offer", () => {
    const state = new Map<string, Unit>();

    expect(toggleLine(state, line(), "кг")).toBe(state);
  });

  it("returns the same state when the unit is already the chosen one", () => {
    const state = new Map<string, Unit>([[PRODUCT, "шт"]]);

    expect(toggleLine(state, line(), "шт")).toBe(state);
  });

  it("returns the same state when clearing a line that is not selected", () => {
    const state = new Map<string, Unit>();

    expect(toggleLine(state, line(), null)).toBe(state);
  });

  it("switches a unitConflict row between its options", () => {
    const target = line({
      group: "manual",
      reason: "unitConflict",
      defaultUnit: null,
      options: [option(200, "г"), option(1, "шт")],
    });

    const first = toggleLine(new Map(), target, "г");
    const second = toggleLine(first, target, "шт");

    expect(second.get(PRODUCT)).toBe("шт");
    expect(second.size).toBe(1);
  });
});

describe("selectionCounts", () => {
  it("takes the header's numbers from the plan and the footer's from the selection", () => {
    const plan = planOf(
      line(),
      line({
        productId: OTHER,
        group: "pantry",
        reason: "inPantry",
        defaultUnit: null,
      }),
    );

    const seeded = seedSelection(plan);
    expect(selectionCounts(plan, seeded)).toEqual({
      include: 1,
      add: 1,
      pantry: 1,
      inCart: 0,
      manual: 0,
    });

    const withPantry = toggleLine(seeded, plan.lines[1] as PreviewLine, "шт");
    expect(selectionCounts(plan, withPantry).include).toBe(2);
    // The header does not move when a pantry row is ticked on — it describes
    // the plan, not the choice.
    expect(selectionCounts(plan, withPantry).pantry).toBe(1);
  });
});

describe("selectionToApplyLines", () => {
  it("sends the confirmed quantity and unit for each ticked line", () => {
    const plan = planOf(line({ note: "покрупнее" }));

    expect(selectionToApplyLines(plan, seedSelection(plan))).toEqual([
      {
        productId: PRODUCT,
        qty: 3,
        unit: "шт",
        note: "покрупнее",
        restore: false,
      },
    ]);
  });

  it("never emits an unselectable line, whatever the map holds", () => {
    const plan = planOf(
      line({
        selectable: false,
        reason: "inCartUnits",
        defaultUnit: null,
        inCart: { qty: 1, unit: "мешок", status: "needed" },
      }),
    );

    expect(
      selectionToApplyLines(plan, new Map([[PRODUCT, "шт" as Unit]])),
    ).toEqual([]);
  });

  it("drops a stale key the plan no longer contains", () => {
    const plan = planOf(line({ defaultUnit: null }));

    expect(
      selectionToApplyLines(plan, new Map([[OTHER, "шт" as Unit]])),
    ).toEqual([]);
  });

  it("drops a selected unit no option offers", () => {
    const plan = planOf(line({ defaultUnit: null }));

    expect(
      selectionToApplyLines(plan, new Map([[PRODUCT, "кг" as Unit]])),
    ).toEqual([]);
  });

  it("carries restore: true for exactly the bought rows", () => {
    const plan = planOf(
      line({
        group: "inCart",
        reason: "inCartBought",
        intent: "restore",
        defaultUnit: null,
        inCart: { qty: 2, unit: "шт", status: "bought" },
      }),
      line({
        productId: OTHER,
        group: "inCart",
        reason: "inCart",
        intent: "add",
        defaultUnit: null,
        inCart: { qty: 2, unit: "шт", status: "needed" },
      }),
    );

    const state = new Map<string, Unit>([
      [PRODUCT, "шт"],
      [OTHER, "шт"],
    ]);

    expect(
      selectionToApplyLines(plan, state).map((entry) => entry.restore),
    ).toEqual([true, false]);
  });

  it("emits at most one entry per product", () => {
    const plan = planOf(line(), line());

    expect(selectionToApplyLines(plan, seedSelection(plan))).toHaveLength(1);
  });

  it("«Добавить N позиций» is exactly what the request carries", () => {
    // The pinned identity, over randomised plans and randomised selections
    // including stale keys and units no option offers.
    for (let seed = 1; seed <= 200; seed += 1) {
      const plan = randomPlan(seed);
      const state = randomSelection(plan, seed * 7919);

      const counts = selectionCounts(plan, state);
      const payload = selectionToApplyLines(plan, state);

      expect(payload.length, `seed ${seed}`).toBe(counts.include);
      expect(new Set(payload.map((entry) => entry.productId)).size).toBe(
        payload.length,
      );
      for (const entry of payload) {
        expect(UNITS).toContain(entry.unit);
      }
    }
  });
});
