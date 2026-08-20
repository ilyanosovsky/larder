import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type StubResult,
} from "@/server/api/test-support";
import { DEFAULT_CATEGORIES } from "@/server/catalog/default-categories";

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
