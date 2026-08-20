import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "./db-errors";

describe("isUniqueViolation", () => {
  it("recognises Postgres 23505", () => {
    expect(
      isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })),
    ).toBe(true);
  });

  it("recognises it on a plain object, not just an Error", () => {
    // The value arrives through drizzle and a transaction wrapper, so it is
    // matched by shape rather than by `instanceof PostgresError`.
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("ignores other Postgres errors", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
  });

  it("ignores a numeric code, so a lookalike is not mistaken for one", () => {
    expect(isUniqueViolation({ code: 23505 })).toBe(false);
  });

  it("ignores values without a code", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("sees through the DrizzleQueryError wrapper", () => {
    // Since drizzle-orm 0.44 this is the shape that actually arrives: the
    // postgres.js error is on `.cause`, and a top-level-only check would turn
    // every lost insert race into an INTERNAL_SERVER_ERROR instead of a
    // CONFLICT.
    const driverError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint_name: "household_members_userId_uidx",
    });
    const wrapped = Object.assign(
      new Error("Failed query: insert into household_members"),
      { cause: driverError },
    );

    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("sees through more than one wrapper layer", () => {
    const nested = { cause: { cause: { code: "23505" } } };

    expect(isUniqueViolation(nested)).toBe(true);
  });

  it("still says no when a wrapped error is a different violation", () => {
    const wrapped = { cause: { code: "23503" } };

    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  it("gives up rather than walking an unbounded chain", () => {
    // Seven layers deep, past the depth limit.
    let deep: object = { code: "23505" };
    for (let i = 0; i < 7; i += 1) {
      deep = { cause: deep };
    }

    expect(isUniqueViolation(deep)).toBe(false);
  });

  it("terminates on a circular cause chain", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;

    expect(isUniqueViolation(a)).toBe(false);
  });

  it("tolerates a null cause", () => {
    expect(isUniqueViolation({ cause: null })).toBe(false);
    expect(isUniqueViolation({ cause: undefined })).toBe(false);
  });
});
