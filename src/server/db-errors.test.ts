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
});
