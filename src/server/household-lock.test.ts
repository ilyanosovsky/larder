import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { householdLockStatement, lockHousehold } from "@/server/household-lock";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";

function compile(statement: ReturnType<typeof householdLockStatement>) {
  return new PgDialect().sqlToQuery(statement);
}

describe("householdLockStatement", () => {
  it("takes a transaction-scoped advisory lock", () => {
    const { sql } = compile(householdLockStatement(HOUSEHOLD_ID));

    // Transaction-scoped, never the session-scoped `pg_advisory_lock`: a
    // session lock would have to be released by hand, and a connection reused
    // by the next serverless request would inherit it.
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).not.toContain("pg_advisory_lock(");
  });

  it("binds the household id as a parameter, cast to text for the hash", () => {
    const { sql, params } = compile(householdLockStatement(HOUSEHOLD_ID));

    expect(sql).toContain("hashtextextended");
    // Bound, not interpolated — the id reaches Postgres as a parameter, and
    // the `::text` cast is what lets `hashtextextended` resolve its argument
    // type without the driver having to declare one.
    expect(sql).toContain("$1::text");
    expect(params).toEqual([HOUSEHOLD_ID]);
  });

  it("keys the lock on the household, so two households never serialize", () => {
    const other = "3f1a6d0e-0000-4000-8000-000000000002";

    expect(compile(householdLockStatement(other)).params).toEqual([other]);
  });
});

describe("lockHousehold", () => {
  it("issues the statement on the handle it is given", async () => {
    const executed: unknown[] = [];
    const tx = {
      execute: (query: unknown) => {
        executed.push(query);
        return Promise.resolve(undefined);
      },
    };

    await lockHousehold(tx, HOUSEHOLD_ID);

    expect(executed).toHaveLength(1);
    expect(compile(executed[0] as ReturnType<typeof householdLockStatement>)) //
      .toMatchObject({ params: [HOUSEHOLD_ID] });
  });
});
