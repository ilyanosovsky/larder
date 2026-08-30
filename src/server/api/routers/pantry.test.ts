import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type RecordedStatement,
  type StubResult,
} from "@/server/api/test-support";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";
const PANTRY_ID = "3f1a6d0e-0000-4000-8000-000000000301";
const ITEM_ID = "3f1a6d0e-0000-4000-8000-000000000401";
const DAIRY_ID = "3f1a6d0e-0000-4000-8000-000000000102";
const PARTNER_ID = "user_2";

const membershipRow = {
  membership: {
    id: "membership_1",
    householdId: HOUSEHOLD_ID,
    userId: "user_1",
    joinedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  household: {
    id: HOUSEHOLD_ID,
    name: "Наш дом",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

function pantryListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PANTRY_ID,
    productId: PRODUCT_ID,
    updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    productName: "Масло сливочное",
    productIcon: "🧈",
    categoryId: DAIRY_ID,
    categoryName: "Молочное и яйца",
    categoryIcon: "🥛",
    ...overrides,
  };
}

function cartRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    productId: PRODUCT_ID,
    qty: 2,
    unit: "шт",
    status: "needed",
    note: null,
    orderedVia: null,
    addedById: "user_1",
    buyerId: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    ...overrides,
  };
}

function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

function compile(clause: unknown): string {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL()).sql;
}

function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  expect(compile(statement?.wheres[0])).toContain('"household_id"');
}

/** household check → the DELETE … RETURNING → the product's defaultUnit read. */
function ranOutPreamble(
  deleted: StubResult = [{ productId: PRODUCT_ID }],
  product: StubResult = [{ defaultUnit: "шт" }],
): StubResult[] {
  return [[membershipRow], deleted, product];
}

describe("pantry.list", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.pantry.list()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.pantry.list()).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("returns the row with its product and department", async () => {
    const { caller } = callerWith([[membershipRow], [pantryListRow()]]);

    await expect(caller.pantry.list()).resolves.toEqual([
      {
        id: PANTRY_ID,
        productId: PRODUCT_ID,
        updatedAt: new Date("2026-08-20T10:00:00.000Z"),
        productName: "Масло сливочное",
        productIcon: "🧈",
        categoryId: DAIRY_ID,
        categoryName: "Молочное и яйца",
        categoryIcon: "🥛",
      },
    ]);
  });

  it("orders by department, then by product name — groupProductsByCategory's contract", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.pantry.list();

    const select = stub.statements[1];
    expect(compile(select?.orderBys[0])).toBe('"categories"."sort_order" asc');
    expect(compile(select?.orderBys[1])).toBe('"products"."name" asc');
  });

  it("reads only this household's pantry rows", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.pantry.list();

    expect(stub.statements[1]).toMatchObject({
      kind: "select",
      table: "pantry_items",
    });
    expectScopedByHousehold(stub.statements[1]);
  });
});

describe("pantry.ranOut", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.pantry.ranOut({ id: PANTRY_ID })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.pantry.ranOut({ id: PANTRY_ID })).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("is a no-op when the pantry row is already gone — a partner's tap won", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.pantry.ranOut({ id: PANTRY_ID })).resolves.toEqual({
      outcome: "gone",
    });

    // household check → the DELETE that matched nothing. Nothing else ran:
    // no product lookup, no cart lock, no write.
    expect(stub.statements).toHaveLength(2);
  });

  it("deletes the caller's own pantry row, scoped by household", async () => {
    const { caller, stub } = callerWith([
      ...ranOutPreamble(),
      [], // no active cart line
      [cartRow({ qty: 1 })],
    ]);

    await caller.pantry.ranOut({ id: PANTRY_ID });

    expect(stub.statements[1]).toMatchObject({
      kind: "delete",
      table: "pantry_items",
    });
    expectScopedByHousehold(stub.statements[1]);
    expect(compile(stub.statements[1]?.wheres[0])).toContain('"id"');
  });

  it("scopes the product lookup to the caller's own household", async () => {
    // Defense in depth (same reasoning as `cart.add`'s own `productId`
    // check): nothing in the schema forces `pantry_items.household_id` and
    // `products.household_id` to agree, so this SELECT has to repeat the
    // guard rather than trust the id alone. Without this test, dropping
    // `eq(products.householdId, householdId)` from that statement leaves the
    // rest of the suite green.
    const { caller, stub } = callerWith([
      ...ranOutPreamble(),
      [],
      [cartRow({ qty: 1 })],
    ]);

    await caller.pantry.ranOut({ id: PANTRY_ID });

    expect(stub.statements[2]).toMatchObject({
      kind: "select",
      table: "products",
    });
    expectScopedByHousehold(stub.statements[2]);
  });

  describe("no active line for the product", () => {
    it("inserts a new needed line at qty 1, in the product's default unit", async () => {
      const { caller, stub } = callerWith([
        ...ranOutPreamble([{ productId: PRODUCT_ID }], [{ defaultUnit: "кг" }]),
        [],
        [cartRow({ qty: 1, unit: "кг" })],
      ]);

      await expect(
        caller.pantry.ranOut({ id: PANTRY_ID }),
      ).resolves.toMatchObject({
        outcome: "added",
        item: { qty: 1, unit: "кг" },
      });

      expect(stub.statements[4]).toMatchObject({
        kind: "insert",
        table: "cart_items",
        values: {
          householdId: HOUSEHOLD_ID,
          productId: PRODUCT_ID,
          qty: 1,
          unit: "кг",
          note: null,
          addedBy: "user_1",
        },
      });
    });

    it("locks the product's active row before deciding anything", async () => {
      const { caller, stub } = callerWith([
        ...ranOutPreamble(),
        [],
        [cartRow({ qty: 1 })],
      ]);

      await caller.pantry.ranOut({ id: PANTRY_ID });

      const lock = stub.statements[3];
      expect(lock).toMatchObject({ kind: "select", table: "cart_items" });
      expect(lock?.lock).toMatchObject({ strength: "update" });
      expectScopedByHousehold(lock);
    });

    it("applies the ordinary rules to the winner when a concurrent insert wins the unique index", async () => {
      const uniqueViolation = Object.assign(new Error("duplicate key"), {
        cause: { code: "23505" },
      });

      const { caller } = callerWith([
        ...ranOutPreamble(),
        [], // first lock: nothing there
        uniqueViolation,
        [cartRow({ qty: 6, status: "needed" })], // recovery read: winner's row
      ]);

      await expect(
        caller.pantry.ranOut({ id: PANTRY_ID }),
      ).resolves.toMatchObject({ outcome: "alreadyInCart", item: { qty: 6 } });
    });
  });

  describe("an open line already in the cart", () => {
    it.each(["needed", "ordered"] as const)(
      "leaves a %s line completely untouched — alreadyInCart",
      async (status) => {
        const { caller, stub } = callerWith([
          ...ranOutPreamble(),
          [cartRow({ status, qty: 3 })],
        ]);

        await expect(
          caller.pantry.ranOut({ id: PANTRY_ID }),
        ).resolves.toMatchObject({
          outcome: "alreadyInCart",
          item: { status, qty: 3 },
        });

        // household → delete → product lookup → the lock. No write at all.
        expect(stub.statements).toHaveLength(4);
      },
    );
  });

  describe("a line bought in the still-open trip", () => {
    it("restores it to needed, keeping its own qty/unit and clearing the purchase", async () => {
      const { caller, stub } = callerWith([
        ...ranOutPreamble(),
        [
          cartRow({
            qty: 6,
            unit: "кг",
            status: "bought",
            buyerId: PARTNER_ID,
            orderedVia: "wolt",
            note: "покрупнее",
          }),
        ],
        [
          cartRow({
            qty: 6,
            unit: "кг",
            status: "needed",
            note: "покрупнее",
          }),
        ],
      ]);

      await expect(
        caller.pantry.ranOut({ id: PANTRY_ID }),
      ).resolves.toMatchObject({
        outcome: "restored",
        item: { qty: 6, unit: "кг", status: "needed" },
      });

      const values = stub.statements[4]?.values as Record<string, unknown>;
      expect(values).toMatchObject({
        status: "needed",
        addedBy: "user_1",
        buyerId: null,
        orderedVia: null,
      });
      // No new quantity to restore to — the row keeps what it already had.
      expect(values).not.toHaveProperty("qty");
      expect(values).not.toHaveProperty("unit");
      expect(values).not.toHaveProperty("note");

      expectScopedByHousehold(stub.statements[4]);
      expect(compile(stub.statements[4]?.wheres[0])).toContain('"id"');
    });
  });

  it("refuses a pantry row that references a product outside the household", async () => {
    // Defense in depth: nothing in the schema forces `pantry_items.household_id`
    // and `products.household_id` to agree (the same gap `cart_items` has).
    const { caller, stub } = callerWith([...ranOutPreamble(undefined, [])]);

    await expect(caller.pantry.ranOut({ id: PANTRY_ID })).rejects.toSatisfy(
      hasCode("INTERNAL_SERVER_ERROR"),
    );
    expect(stub.statements).toHaveLength(3);
  });

  it("gives up rather than looping when the winner cannot be found", async () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      cause: { code: "23505" },
    });

    const { caller } = callerWith([
      ...ranOutPreamble(),
      [],
      uniqueViolation,
      [],
      uniqueViolation,
    ]);

    await expect(caller.pantry.ranOut({ id: PANTRY_ID })).rejects.toSatisfy(
      hasCode("INTERNAL_SERVER_ERROR"),
    );
  });
});
