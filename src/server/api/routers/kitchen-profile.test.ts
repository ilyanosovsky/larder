import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { kitchenProfiles } from "@/db/schema";
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

function compile(condition: unknown): string {
  expect(isSQLWrapper(condition)).toBe(true);
  return new PgDialect().sqlToQuery((condition as SQLWrapper).getSQL()).sql;
}

/**
 * Same idea as `category.test.ts`'s `expectScopedByHousehold`: compiling the
 * `WHERE` is the only way to prove a refactor did not drop
 * `eq(kitchenProfiles.householdId, ctx.household.id)` while still passing
 * every other assertion on stubbed values alone.
 */
function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  expect(compile(statement?.wheres[0])).toContain('"household_id"');
}

describe("kitchenProfile.get", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.kitchenProfile.get()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.kitchenProfile.get()).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("returns null when the household has never set a profile", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.kitchenProfile.get()).resolves.toBeNull();
  });

  it("returns the household's profile when one exists", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [{ householdSize: 3, equipment: ["oven", "Соковыжималка"] }],
    ]);

    await expect(caller.kitchenProfile.get()).resolves.toEqual({
      householdSize: 3,
      equipment: ["oven", "Соковыжималка"],
    });
  });

  it("scopes the select to the caller's own household", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.kitchenProfile.get();

    const select = stub.statements[1];
    expect(select).toMatchObject({ kind: "select", table: "kitchen_profiles" });
    expectScopedByHousehold(select);
  });
});

describe("kitchenProfile.update", () => {
  const validInput = { householdSize: 2, equipment: ["oven", "kettle"] };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.kitchenProfile.update(validInput)).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.kitchenProfile.update(validInput)).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("rejects a household size of 0 before touching the table", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(
      caller.kitchenProfile.update({ ...validInput, householdSize: 0 }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    // Only the householdProcedure membership check ran.
    expect(stub.statements).toHaveLength(1);
  });

  it("rejects a household size of 11", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(
      caller.kitchenProfile.update({ ...validInput, householdSize: 11 }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    expect(stub.statements).toHaveLength(1);
  });

  it("rejects more than 50 equipment entries", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);
    const tooMany = Array.from({ length: 51 }, (_, i) => `item-${i}`);

    await expect(
      caller.kitchenProfile.update({ ...validInput, equipment: tooMany }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    expect(stub.statements).toHaveLength(1);
  });

  it("rejects an empty-string equipment entry", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(
      caller.kitchenProfile.update({ ...validInput, equipment: [""] }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));
    expect(stub.statements).toHaveLength(1);
  });

  it("normalizes equipment before writing it", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ householdSize: 2, equipment: ["oven", "Мультиварка"] }],
    ]);

    await caller.kitchenProfile.update({
      householdSize: 2,
      equipment: ["oven", "oven", "  Мультиварка  ", "мультиварка"],
    });

    const insert = stub.statements[1];
    expect(insert).toMatchObject({
      kind: "insert",
      table: "kitchen_profiles",
      values: {
        householdId: HOUSEHOLD_ID,
        householdSize: 2,
        equipment: ["oven", "Мультиварка"],
      },
    });
  });

  it("scopes the write to the caller's own household — there is no client-sent id", async () => {
    const { caller, stub } = callerWith([[membershipRow], [validInput]]);

    await caller.kitchenProfile.update(validInput);

    expect(stub.statements[1]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
    });
  });

  it("upserts via onConflictDoUpdate on householdId", async () => {
    const { caller, stub } = callerWith([[membershipRow], [validInput]]);

    await caller.kitchenProfile.update(validInput);

    const insert = stub.statements[1];
    // The conflict target is the primary key column itself — one row per
    // household, upserted on the same column the schema keys it by.
    expect(insert?.onConflict?.target).toBe(kitchenProfiles.householdId);
    expect(insert?.onConflict).toMatchObject({
      set: { householdSize: 2, equipment: ["oven", "kettle"] },
    });
  });

  it("throws INTERNAL_SERVER_ERROR if the upsert somehow returns no row", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.kitchenProfile.update(validInput)).rejects.toSatisfy(
      hasCode("INTERNAL_SERVER_ERROR"),
    );
  });
});
