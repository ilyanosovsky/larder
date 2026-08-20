import { describe, expect, it } from "vitest";

import { isConflictError, trpcErrorCode } from "./trpc-errors";

/** The shape `errorFormatter` produces, as a TRPCClientError carries it. */
function clientError(code: string) {
  return Object.assign(new Error(code), { data: { code, zodError: null } });
}

describe("trpcErrorCode", () => {
  it("reads the code off a tRPC client error", () => {
    expect(trpcErrorCode(clientError("CONFLICT"))).toBe("CONFLICT");
    expect(trpcErrorCode(clientError("NOT_FOUND"))).toBe("NOT_FOUND");
  });

  it("returns null for anything that is not one", () => {
    expect(trpcErrorCode(new Error("network down"))).toBeNull();
    expect(trpcErrorCode({ data: null })).toBeNull();
    expect(trpcErrorCode({ data: {} })).toBeNull();
    expect(trpcErrorCode({ data: { code: 409 } })).toBeNull();
    expect(trpcErrorCode("CONFLICT")).toBeNull();
    expect(trpcErrorCode(null)).toBeNull();
    expect(trpcErrorCode(undefined)).toBeNull();
  });
});

describe("isConflictError", () => {
  it("recognises the CONFLICT the onboarding screen treats as success", () => {
    // A retried household.create means the household already exists, which is
    // the outcome the caller wanted — not a failure to show a form for.
    expect(isConflictError(clientError("CONFLICT"))).toBe(true);
  });

  it("does not mistake another failure for it", () => {
    expect(isConflictError(clientError("INTERNAL_SERVER_ERROR"))).toBe(false);
    expect(isConflictError(clientError("UNAUTHORIZED"))).toBe(false);
    // A dropped connection has no code at all, and must re-show the form.
    expect(isConflictError(new Error("Failed to fetch"))).toBe(false);
  });
});
