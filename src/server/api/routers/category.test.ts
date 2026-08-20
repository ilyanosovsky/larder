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

const CAT_1 = {
  id: "3f1a6d0e-0000-4000-8000-000000000101",
  name: "Овощи и фрукты",
  icon: "🥬",
  sortOrder: 0,
};
const CAT_2 = {
  id: "3f1a6d0e-0000-4000-8000-000000000102",
  name: "Молочное и яйца",
  icon: "🥛",
  sortOrder: 1,
};
const CAT_3 = {
  id: "3f1a6d0e-0000-4000-8000-000000000103",
  name: "Мясо и курица",
  icon: "🥩",
  sortOrder: 2,
};

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

function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

/**
 * Compiles a recorded statement's first `WHERE` and asserts it mentions
 * `household_id` — the tenancy guard every household-scoped query and
 * write must carry, per-row `id` alone is never enough (VISION §6.7). If a
 * refactor ever drops the `eq(categories.householdId, ...)` half of a
 * `select`/`update`, this fails even though the stub's queued rows still
 * make the surrounding test pass on values alone.
 */
function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  const condition = statement?.wheres[0];
  expect(isSQLWrapper(condition)).toBe(true);
  const { sql: text } = new PgDialect().sqlToQuery(
    (condition as SQLWrapper).getSQL(),
  );
  expect(text).toContain('"household_id"');
}

describe("category.list", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.category.list()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.category.list()).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("returns the household's categories", async () => {
    // householdProcedure membership check → category select
    const { caller } = callerWith([[membershipRow], [CAT_1, CAT_2, CAT_3]]);

    await expect(caller.category.list()).resolves.toEqual([
      CAT_1,
      CAT_2,
      CAT_3,
    ]);
  });

  it("scopes the select to the caller's own household", async () => {
    const { caller, stub } = callerWith([[membershipRow], [CAT_1]]);

    await caller.category.list();

    const select = stub.statements[1];
    expect(select).toMatchObject({ kind: "select", table: "categories" });
    expectScopedByHousehold(select);
  });
});

describe("category.reorder", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.category.reorder({ orderedIds: [CAT_1.id] }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(
      caller.category.reorder({ orderedIds: [CAT_1.id] }),
    ).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("rejects an empty orderedIds array before touching the categories table", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(caller.category.reorder({ orderedIds: [] })).rejects.toSatisfy(
      hasCode("BAD_REQUEST"),
    );
    // Only the householdProcedure membership check ran.
    expect(stub.statements).toHaveLength(1);
  });

  it("rejects more than 100 ids", async () => {
    const { caller } = callerWith([[membershipRow]]);
    const tooMany = Array.from({ length: 101 }, () => CAT_1.id);

    await expect(
      caller.category.reorder({ orderedIds: tooMany }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
  });

  it("rejects an orderedIds list that is not exactly the household's own categories", async () => {
    // household check → the household's existing category ids
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: CAT_1.id }, { id: CAT_2.id }, { id: CAT_3.id }],
    ]);

    // Missing CAT_3, and an id that belongs to nobody.
    await expect(
      caller.category.reorder({
        orderedIds: [
          CAT_1.id,
          CAT_2.id,
          "3f1a6d0e-0000-4000-8000-00000000ffff",
        ],
      }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    // No update was issued.
    expect(stub.statements).toHaveLength(2);
  });

  it("rejects a duplicated id even if the set is otherwise complete", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: CAT_1.id }, { id: CAT_2.id }],
    ]);

    await expect(
      caller.category.reorder({ orderedIds: [CAT_1.id, CAT_1.id] }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    expect(stub.statements).toHaveLength(2);
  });

  it("updates each category's sortOrder to its index in the given order", async () => {
    // household check → existing ids → 3 updates, one per reordered id
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: CAT_1.id }, { id: CAT_2.id }, { id: CAT_3.id }],
      [],
      [],
      [],
    ]);

    await expect(
      caller.category.reorder({
        orderedIds: [CAT_3.id, CAT_1.id, CAT_2.id],
      }),
    ).resolves.toBeUndefined();

    expect(stub.statements).toHaveLength(5);
    expect(stub.statements[2]).toMatchObject({
      kind: "update",
      table: "categories",
      values: { sortOrder: 0 },
    });
    expect(stub.statements[3]).toMatchObject({
      kind: "update",
      table: "categories",
      values: { sortOrder: 1 },
    });
    expect(stub.statements[4]).toMatchObject({
      kind: "update",
      table: "categories",
      values: { sortOrder: 2 },
    });
  });

  it("scopes the existing-ids lookup and every update to the caller's own household", async () => {
    // A refactor that dropped `eq(categories.householdId, ctx.household.id)`
    // from either the lookup or the per-row update would still pass every
    // other reorder test — the stub's queued rows don't know or care what
    // the WHERE actually filtered on, only that a statement of the right
    // shape ran. Compiling the WHERE is the only way to prove the tenancy
    // guard survived.
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: CAT_1.id }, { id: CAT_2.id }, { id: CAT_3.id }],
      [],
      [],
      [],
    ]);

    await caller.category.reorder({
      orderedIds: [CAT_3.id, CAT_1.id, CAT_2.id],
    });

    const existingIdsSelect = stub.statements[1];
    expect(existingIdsSelect).toMatchObject({
      kind: "select",
      table: "categories",
    });
    expectScopedByHousehold(existingIdsSelect);

    for (const index of [2, 3, 4]) {
      const update = stub.statements[index];
      expect(update).toMatchObject({ kind: "update", table: "categories" });
      expectScopedByHousehold(update);
    }
  });
});
