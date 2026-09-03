import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  testUser,
  unusableDb,
  type StubResult,
} from "@/server/api/test-support";
import { DEFAULT_CATEGORIES } from "@/server/catalog/default-categories";

/** Compiles a recorded clause, keeping the bound parameters — a column name
 * alone does not prove the right *value* is bound (task 7.1a review). */
function compile(clause: unknown): { sql: string; params: unknown[] } {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL());
}

const HOUSEHOLD = {
  id: "3f1a6d0e-0000-4000-8000-000000000001",
  name: "Наш дом",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

const MEMBER = {
  userId: "user_1",
  name: "Кира",
  image: null,
  joinedAt: new Date("2026-08-01T00:00:00.000Z"),
};

/** Signed-in caller whose statements resolve to `results`, in call order. */
function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

describe("household.current", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.household.current()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("returns null before onboarding instead of erroring", async () => {
    // The (app) layout and the onboarding page both branch on this null, so
    // "no household yet" must stay a normal answer.
    const { caller } = callerWith([[]]);

    await expect(caller.household.current()).resolves.toBeNull();
  });

  it("returns the household with its members", async () => {
    const { caller } = callerWith([[{ household: HOUSEHOLD }], [MEMBER]]);

    await expect(caller.household.current()).resolves.toEqual({
      household: HOUSEHOLD,
      members: [MEMBER],
    });
  });

  it("does not look up members when there is no membership", async () => {
    const { caller, stub } = callerWith([[]]);

    await caller.household.current();

    expect(stub.statements).toHaveLength(1);
  });

  /**
   * The tenancy guard (VISION §6.7), both halves: the first statement is
   * scoped to the caller (`household_members.user_id = ctx.user.id`), and
   * the second — the members roster — is scoped to the household that first
   * statement resolved (`household_members.household_id = ...`), not
   * trusted blind. `createDbStub` replays queued results by call order
   * without ever evaluating a `where`, so `resolves.toEqual(...)` above
   * stays green even if either predicate is deleted entirely — this is what
   * would actually catch that (task 7.1a review, F3 + G1: pre-existing gap,
   * newly worth closing now that this list renders as a named roster on
   * `/settings`).
   */
  it("scopes both the caller lookup and the members roster by their own predicates, with the join and order the roster depends on", async () => {
    const { caller, stub } = callerWith([[{ household: HOUSEHOLD }], [MEMBER]]);

    await caller.household.current();

    const membership = compile(stub.statements[0]?.wheres[0]);
    expect(membership.sql).toContain('"user_id"');
    expect(membership.params).toEqual([testUser.id]);

    const members = stub.statements[1];
    expect(members).toMatchObject({
      kind: "select",
      table: "household_members",
    });

    const where = compile(members?.wheres[0]);
    expect(where.sql).toContain('"household_id"');
    // The bound literal, not only the column — a `WHERE household_id = $1`
    // guard is only as good as what actually gets bound to `$1`.
    expect(where.params).toEqual([HOUSEHOLD.id]);

    const join = compile(members?.joins[0]);
    expect(join.sql).toContain('"users"."id"');
    expect(join.sql).toContain('"household_members"."user_id"');

    const orderBy = compile(members?.orderBys[0]);
    // The whole fragment, not a substring — `toContain('"joined_at"')` alone
    // would still pass for `desc(householdMembers.joinedAt)`, silently
    // flipping the roster from oldest-member-first to newest-first.
    expect(orderBy.sql).toBe('"household_members"."joined_at"');
  });
});

describe("household.create", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(
      caller.household.create({ name: "Наш дом" }),
    ).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("rejects a blank name", async () => {
    const caller = createCaller(signedInContext(unusableDb));

    await expect(caller.household.create({ name: "   " })).rejects.toSatisfy(
      hasCode("BAD_REQUEST"),
    );
  });

  it("trims the name before storing it", async () => {
    // membership pre-check → household insert → membership insert → categories insert
    const { caller, stub } = callerWith([[], [HOUSEHOLD], [], []]);

    await caller.household.create({ name: "  Наш дом  " });

    expect(stub.statements[1]).toMatchObject({
      kind: "insert",
      table: "households",
      values: { name: "Наш дом" },
    });
  });

  it("makes the creator the first member", async () => {
    const { caller, stub } = callerWith([[], [HOUSEHOLD], [], []]);

    await expect(caller.household.create({ name: "Наш дом" })).resolves.toEqual(
      HOUSEHOLD,
    );
    expect(stub.statements[2]).toMatchObject({
      kind: "insert",
      table: "household_members",
      values: { householdId: HOUSEHOLD.id, userId: "user_1" },
    });
  });

  it("seeds the 7 default departments, in route order", async () => {
    const { caller, stub } = callerWith([[], [HOUSEHOLD], [], []]);

    await caller.household.create({ name: "Наш дом" });

    expect(stub.statements[3]).toMatchObject({
      kind: "insert",
      table: "categories",
    });
    expect(stub.statements[3]?.values).toEqual(
      DEFAULT_CATEGORIES.map((category, index) => ({
        householdId: HOUSEHOLD.id,
        name: category.name,
        icon: category.icon,
        sortOrder: index,
      })),
    );
  });

  it("refuses a second household with CONFLICT", async () => {
    const { caller, stub } = callerWith([[{ id: "membership_1" }]]);

    await expect(
      caller.household.create({ name: "Второй дом" }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
    // Nothing was written: the pre-check ran and stopped there.
    expect(stub.statements).toHaveLength(1);
  });

  it("turns the unique-index race into the same CONFLICT", async () => {
    // Two tabs create at once: the pre-check passes in both, and Postgres
    // rejects the second membership insert (VISION §5, one household per user).
    const { caller } = callerWith([
      [],
      [HOUSEHOLD],
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    ]);

    await expect(
      caller.household.create({ name: "Наш дом" }),
    ).rejects.toSatisfy(hasCode("CONFLICT"));
  });

  it("does not swallow an unrelated database error", async () => {
    const { caller } = callerWith([[], new Error("connection lost")]);

    await expect(caller.household.create({ name: "Наш дом" })).rejects.toThrow(
      "connection lost",
    );
  });
});
